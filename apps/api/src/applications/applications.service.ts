import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { CvService } from '../cv/cv.service';
import { MatchingService } from '../matching/matching.service';
import { CampaignService } from '../campaign/campaign.service';
import { ApplicationPrepService } from './application-prep.service';
import { AddManualOfferDto } from './dto/add-manual.dto';
import { createHash } from 'crypto';

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
  // of which run produced it.
  async list(status?: string, scope?: 'current' | 'history') {
    const userId = await this.localUser.getDefaultUserId();

    let runFilter: Record<string, any> = {};
    if (status === 'to_apply' && scope) {
      const latestRun = await this.campaignService.getLatestRun();
      const latestRunId = latestRun?.id;
      runFilter = scope === 'history'
        ? { campaignRunId: latestRunId ? { not: latestRunId } : { not: null } }
        : { OR: [{ campaignRunId: null }, ...(latestRunId ? [{ campaignRunId: latestRunId }] : [])] };
    }

    return this.prisma.application.findMany({
      where: { userId, ...(status ? { status } : {}), ...runFilter },
      include: { jobOffer: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string) {
    const application = await this.prisma.application.findUnique({
      where: { id },
      include: { jobOffer: true },
    });

    if (!application) {
      throw new NotFoundException('Application not found');
    }

    return application;
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

    return this.prisma.application.update({
      where: { id },
      data: { status: 'applied', appliedAt: new Date() },
      include: { jobOffer: true },
    });
  }

  async remove(id: string) {
    await this.getById(id);
    return this.prisma.application.delete({ where: { id } });
  }

  async removeAll(status?: string) {
    const userId = await this.localUser.getDefaultUserId();
    const result = await this.prisma.application.deleteMany({
      where: { userId, ...(status ? { status } : {}) },
    });
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

  async getCvData(id: string) {
    const application = await this.getById(id);
    if (application.adaptedCvData) {
      return application.adaptedCvData as any;
    }

    const userId = await this.localUser.getDefaultUserId();
    return this.cvService.getCV(userId);
  }
}
