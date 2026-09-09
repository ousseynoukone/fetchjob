import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { CvService } from '../cv/cv.service';
import { MatchingService } from '../matching/matching.service';
import { CampaignService } from '../campaign/campaign.service';
import { ApplicationPrepService } from './application-prep.service';
import { AddManualOfferDto } from './dto/add-manual.dto';
import type { CVData } from '../pdf/templates/cv-document';
import { createHash } from 'crypto';

// Statuses that imply a real submission happened at some point (auto-apply
// success or manual "Marquer comme postulée") — used to keep
// Campaign.totalApplicationsSent accurate when candidatures are deleted.
// 'to_apply', 'needs_review' and 'ignored' never reached that point.
const SENT_STATUSES = ['applied', 'interview', 'offer', 'rejected'];

@Injectable()
export class ApplicationsService {
  constructor(
    private prisma: PrismaService,
    private localUser: LocalUserService,
    private cvService: CvService,
    private matching: MatchingService,
    private campaignService: CampaignService,
    private prep: ApplicationPrepService,
  ) {}

  // `scope` only matters for the to_apply status: 'current' keeps the "À
  // postuler" list to what the latest campaign run actually surfaced (plus
  // anything with no run at all — manual offers, or candidatures prepared
  // before campaignRunId existed), 'history' shows what got left behind by
  // an older run instead. Every other status ignores it — once you've acted
  // on a candidature (applied/interview/...), it stays visible regardless
  // of which run produced it. Shared by list() and removeAll() so "delete
  // this tab" always matches exactly what that tab is showing.
  private async buildStatusScopeFilter(userId: string, status?: string, scope?: 'current' | 'history') {
    let runFilter: Record<string, any> = {};
    if (status === 'to_apply' && scope) {
      const latestRun = await this.campaignService.getLatestRun();
      const latestRunId = latestRun?.id;
      runFilter = scope === 'history'
        ? { campaignRunId: latestRunId ? { not: latestRunId } : { not: null } }
        : { OR: [{ campaignRunId: null }, ...(latestRunId ? [{ campaignRunId: latestRunId }] : [])] };
    }
    return { userId, ...(status ? { status } : {}), ...runFilter };
  }

  async list(status?: string, scope?: 'current' | 'history') {
    const userId = await this.localUser.getDefaultUserId();
    const where = await this.buildStatusScopeFilter(userId, status, scope);

    return this.prisma.application.findMany({
      where,
      include: { jobOffer: true },
      omit: { screenshot: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Keeps Campaign.totalApplicationsPrepared/totalApplicationsSent accurate
  // after a delete — without this, those counters (shown on the Campagne
  // page) keep counting rows that no longer exist, drifting further from
  // reality with every cleanup. Grouped by campaign in case more than one
  // exists, though in practice this tool only ever has the one.
  private async decrementCampaignStats(deleted: { campaignId: string; status: string }[]) {
    if (!deleted.length) return;

    const byCampaign = new Map<string, { prepared: number; sent: number }>();
    for (const row of deleted) {
      const entry = byCampaign.get(row.campaignId) || { prepared: 0, sent: 0 };
      entry.prepared += 1;
      if (SENT_STATUSES.includes(row.status)) entry.sent += 1;
      byCampaign.set(row.campaignId, entry);
    }

    for (const [campaignId, counts] of byCampaign) {
      const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign) continue;
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: {
          // Clamped via Math.min rather than a raw decrement: stats that
          // predate this fix (or drifted for any other reason) could
          // otherwise go negative.
          totalApplicationsPrepared: { decrement: Math.min(counts.prepared, campaign.totalApplicationsPrepared) },
          totalApplicationsSent: { decrement: Math.min(counts.sent, campaign.totalApplicationsSent) },
        },
      });
    }
  }

  async getById(id: string) {
    const application = await this.prisma.application.findUnique({
      where: { id },
      include: { jobOffer: true },
      omit: { screenshot: true },
    });

    if (!application) {
      throw new NotFoundException('Application not found');
    }

    return application;
  }

  // The screenshot itself is only ever fetched through its own binary
  // endpoint (see ApplicationsController) — kept out of list()/getById() so
  // an ordinary candidature fetch never drags a ~100-200KB image along.
  async getScreenshot(id: string): Promise<Buffer | null> {
    const application = await this.prisma.application.findUnique({
      where: { id },
      select: { screenshot: true },
    });
    return application?.screenshot ?? null;
  }

  async updateStatus(id: string, status: string) {
    await this.getById(id);
    return this.prisma.application.update({
      where: { id },
      data: { status },
      include: { jobOffer: true },
    });
  }

  async markApplied(id: string) {
    const application = await this.getById(id);
    await this.prisma.campaign.update({
      where: { id: application.campaignId },
      data: { totalApplicationsSent: { increment: 1 } },
    });

    // No per-candidature email here — DigestService reads `appliedAt`
    // directly off the Application table and sends a periodic summary
    // instead (see digest.service.ts), covering this manual path too.
    return this.prisma.application.update({
      where: { id },
      data: { status: 'applied', appliedAt: new Date() },
      include: { jobOffer: true },
    });
  }

  async remove(id: string) {
    await this.getById(id);
    const deleted = await this.prisma.application.delete({ where: { id } });
    await this.decrementCampaignStats([{ campaignId: deleted.campaignId, status: deleted.status }]);
    return deleted;
  }

  // `status`/`scope` scope this to exactly one tab (e.g. "à postuler" alone,
  // or just its history) instead of only ever offering "this one status" or
  // "everything" — both left undefined still wipes every candidature.
  async removeAll(status?: string, scope?: 'current' | 'history') {
    const userId = await this.localUser.getDefaultUserId();
    const where = await this.buildStatusScopeFilter(userId, status, scope);

    const toDelete = await this.prisma.application.findMany({
      where,
      select: { campaignId: true, status: true },
    });

    const result = await this.prisma.application.deleteMany({ where });
    await this.decrementCampaignStats(toDelete);

    return { deleted: result.count };
  }

  async regenerate(id: string) {
    const application = await this.getById(id);
    const userId = await this.localUser.getDefaultUserId();
    const cv = await this.cvService.getCV(userId);

    const { application: updated, failures, errorMessage } = await this.prep.prepareMaterials(
      id,
      cv,
      application.jobOffer,
      userId,
    );

    if (failures.length === 3) {
      throw new ServiceUnavailableException(
        `La génération IA a échoué : ${errorMessage || 'erreur inconnue'}. Vérifiez la clé DeepSeek dans Paramètres.`,
      );
    }

    return updated;
  }

  async addManual(dto: AddManualOfferDto) {
    const userId = await this.localUser.getDefaultUserId();
    const campaign = await this.campaignService.getOrCreateCampaign();
    const cv = await this.cvService.getCV(userId);

    const externalId = createHash('sha1').update(dto.url).digest('hex');

    const jobOffer = await this.prisma.jobOffer.upsert({
      where: { source_externalId: { source: 'manual', externalId } },
      update: {
        title: dto.title,
        company: dto.company,
        location: dto.location,
        description: dto.description,
      },
      create: {
        externalId,
        source: 'manual',
        title: dto.title,
        company: dto.company,
        location: dto.location,
        description: dto.description,
        url: dto.url,
      },
    });

    const existing = await this.prisma.application.findUnique({
      where: { campaignId_jobOfferId: { campaignId: campaign.id, jobOfferId: jobOffer.id } },
      include: { jobOffer: true },
    });
    if (existing) return existing;

    const result = this.matching.match(
      cv,
      {
        title: jobOffer.title,
        description: jobOffer.description,
        location: jobOffer.location || '',
      },
      (campaign.keywords as string[]) || [],
      (campaign.seniorityKeywords as string[]) || [],
    );

    return this.prisma.application.create({
      data: {
        userId,
        campaignId: campaign.id,
        jobOfferId: jobOffer.id,
        jobTitle: jobOffer.title,
        company: jobOffer.company,
        location: jobOffer.location,
        sourceUrl: jobOffer.url,
        matchScore: result.score,
        matchedSkills: result.matchedSkills,
        missingSkills: result.missingSkills,
      },
      include: { jobOffer: true },
    });
  }

  async getCvData(id: string): Promise<CVData> {
    const application = await this.getById(id);
    const userId = await this.localUser.getDefaultUserId();
    const liveCv = await this.cvService.getCV(userId);

    if (application.adaptedCvData) {
      // adaptedCvData is a frozen AI snapshot taken when the candidature was
      // prepared — it's meant to capture offer-specific experience/project
      // adaptations, not your identity. If fullName/email/etc were blank (or
      // have since changed) at snapshot time, every candidature prepared
      // before the fix would otherwise permanently show stale contact info.
      // Always take identity fields from the live CV instead.
      const snapshot = application.adaptedCvData as Record<string, any>;
      return {
        ...snapshot,
        fullName: liveCv.fullName,
        headline: liveCv.headline,
        email: liveCv.email,
        phone: liveCv.phone,
        location: liveCv.location,
        links: liveCv.links,
      } as CVData;
    }

    return liveCv as CVData;
  }
}
