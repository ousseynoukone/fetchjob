import { Injectable, Logger } from '@nestjs/common';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaService } from '../common/prisma.service';
import { CvService } from '../cv/cv.service';
import { PdfService } from '../pdf/pdf.service';
import { PlatformCredentialsService } from '../platform-credentials/platform-credentials.service';
import { SUPPORTED_PLATFORMS, SupportedPlatform } from '../platform-credentials/dto/upsert-credential.dto';
import { BrowserSessionService } from './browser-session.service';
import { LinkedInApplier } from './appliers/linkedin.applier';
import { IndeedApplier } from './appliers/indeed.applier';
import { FranceTravailApplier } from './appliers/france-travail.applier';
import { HelloWorkApplier } from './appliers/hellowork.applier';
import { GreenhouseApplier } from './appliers/greenhouse.applier';
import { LeverApplier } from './appliers/lever.applier';
import { WorkdayApplier } from './appliers/workday.applier';
import { SmartRecruitersApplier } from './appliers/smartrecruiters.applier';
import { GenericRedirectApplier } from './appliers/generic-redirect.applier';
import { JobApplier } from './appliers/applier.interface';
import { scanInvalidFields } from './appliers/form-fields';
import { CustomQuestionsService } from '../custom-questions/custom-questions.service';
import type { CVData } from '../pdf/templates/cv-document';
import type { Page } from 'playwright';

// Matched against `sourceUrl`'s hostname regardless of which source scraped
// the offer (Adzuna, Remotive, The Muse... are aggregators that redirect to
// whatever the employer actually uses) — these four ATS platforms cover a
// large share of company career sites, so detecting them by URL catches far
// more real candidatures than a per-aggregator applier ever could.
const ATS_HOST_PATTERNS: { pattern: RegExp; key: string }[] = [
  { pattern: /(^|\.)greenhouse\.io$/i, key: 'greenhouse' },
  { pattern: /(^|\.)lever\.co$/i, key: 'lever' },
  { pattern: /myworkdayjobs\.com$/i, key: 'workday' },
  { pattern: /(^|\.)smartrecruiters\.com$/i, key: 'smartrecruiters' },
];

function detectAtsKey(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    return ATS_HOST_PATTERNS.find(({ pattern }) => pattern.test(hostname))?.key || null;
  } catch {
    return null;
  }
}

export interface AutoApplyRunResult {
  applied: number;
  needsReview: number;
}

@Injectable()
export class AutoApplyService {
  private readonly logger = new Logger(AutoApplyService.name);
  private readonly appliers: Record<string, JobApplier>;

  private readonly atsAppliers: Record<string, JobApplier>;

  constructor(
    private prisma: PrismaService,
    private cvService: CvService,
    private pdfService: PdfService,
    private credentials: PlatformCredentialsService,
    private browserSession: BrowserSessionService,
    private customQuestions: CustomQuestionsService,
    linkedin: LinkedInApplier,
    indeed: IndeedApplier,
    franceTravail: FranceTravailApplier,
    helloWork: HelloWorkApplier,
    greenhouse: GreenhouseApplier,
    lever: LeverApplier,
    workday: WorkdayApplier,
    smartRecruiters: SmartRecruitersApplier,
    private genericFallback: GenericRedirectApplier,
  ) {
    this.appliers = {
      linkedin,
      indeed,
      france_travail: franceTravail,
      hellowork: helloWork,
    };
    this.atsAppliers = {
      greenhouse,
      lever,
      workday,
      smartrecruiters: smartRecruiters,
    };
  }

  // URL-based ATS detection takes priority: an Adzuna/Remotive/The Muse/...
  // listing that happens to link to a Greenhouse/Lever/Workday/SmartRecruiters
  // posting has a real form to drive there, regardless of which source
  // scraped it — the source-keyed appliers below only cover offers actually
  // hosted on that platform's own domain. `atsEnabled` lets a campaign opt
  // out of ATS-based submission independently of the account-based platforms.
  private getApplier(source: string, sourceUrl: string, atsEnabled: boolean): { applier: JobApplier; platformKey: string } {
    if (atsEnabled) {
      const atsKey = detectAtsKey(sourceUrl);
      if (atsKey && this.atsAppliers[atsKey]) return { applier: this.atsAppliers[atsKey], platformKey: atsKey };
    }
    if (this.appliers[source]) return { applier: this.appliers[source], platformKey: source };
    return { applier: this.genericFallback, platformKey: source };
  }

  // Merges the AI-adapted snapshot with live identity fields — same logic
  // as ApplicationsService.getCvData, duplicated here rather than imported
  // to avoid a module cycle (ApplicationsModule already depends on
  // CampaignModule, which is what invokes auto-apply).
  private async buildCvData(applicationId: string, userId: string): Promise<CVData> {
    const application = await this.prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const liveCv = await this.cvService.getCV(userId);

    if (application.adaptedCvData) {
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

  async run(params: {
    userId: string;
    applicationIds: string[];
    atsEnabled: boolean;
    minDelaySeconds: number;
    maxDelaySeconds: number;
    appendLog: (message: string) => Promise<void>;
  }): Promise<AutoApplyRunResult> {
    const { userId, applicationIds, atsEnabled, appendLog } = params;
    const minDelaySeconds = Math.min(params.minDelaySeconds, params.maxDelaySeconds);
    const maxDelaySeconds = Math.max(params.minDelaySeconds, params.maxDelaySeconds);
    // Loaded once for the whole run rather than per candidature — a
    // question answered mid-run should still only need answering once.
    const knownAnswers = await this.customQuestions.getKnownAnswers(userId);
    let applied = 0;
    let needsReview = 0;

    for (let i = 0; i < applicationIds.length; i++) {
      const applicationId = applicationIds[i];
      const application = await this.prisma.application.findUnique({
        where: { id: applicationId },
        include: { jobOffer: true },
      });
      if (!application) continue;

      try {
        const result = await this.applyToOne(userId, application, atsEnabled, knownAnswers);
        if (result.success) {
          applied++;
          await this.prisma.$transaction([
            this.prisma.application.update({
              where: { id: applicationId },
              data: { status: 'applied', appliedAt: new Date(), autoApplyNote: null },
            }),
            this.prisma.campaign.update({
              where: { id: application.campaignId },
              data: { totalApplicationsSent: { increment: 1 } },
            }),
          ]);
          await appendLog(`Auto-apply réussi: ${application.jobTitle} chez ${application.company}`);
        } else {
          needsReview++;
          await this.prisma.application.update({
            where: { id: applicationId },
            data: { status: 'needs_review', autoApplyNote: result.note },
          });
          await appendLog(
            `Auto-apply à vérifier: ${application.jobTitle} chez ${application.company} — ${result.note}`,
          );
        }
      } catch (error: any) {
        needsReview++;
        const note = `Erreur inattendue pendant l'auto-apply: ${error.message}`;
        await this.prisma.application.update({
          where: { id: applicationId },
          data: { status: 'needs_review', autoApplyNote: note },
        });
        await appendLog(`Auto-apply en échec: ${application.jobTitle} chez ${application.company} — ${error.message}`);
        this.logger.warn(`Auto-apply crashed for application ${applicationId}: ${error.message}`);
      }

      if (i < applicationIds.length - 1) {
        await this.browserSession.randomDelay(minDelaySeconds * 1000, maxDelaySeconds * 1000);
      }
    }

    return { applied, needsReview };
  }

  private async applyToOne(
    userId: string,
    application: { id: string; jobTitle: string; company: string; sourceUrl: string; coverLetter: string | null; jobOffer: { source: string } },
    atsEnabled: boolean,
    knownAnswers: Map<string, string>,
  ) {
    const { applier, platformKey } = this.getApplier(application.jobOffer.source, application.sourceUrl, atsEnabled);
    const platform = applier.credentialPlatform as SupportedPlatform | null;

    let credential: { email: string; password: string } | null = null;
    let sessionState: string | null = null;
    if (platform && (SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
      try {
        const decrypted = await this.credentials.getDecrypted(userId, platform);
        credential = { email: decrypted.email, password: decrypted.password };
        sessionState = decrypted.sessionState;
      } catch {
        // No credential saved — the applier will hit its login wall and
        // report a clear "no credential" needs_review note on its own.
      }
    }

    const cv = await this.buildCvData(application.id, userId);
    const pdfBuffer = await this.pdfService.generateCVPdf(cv);
    const cvPdfPath = join(tmpdir(), `findurjob-auto-apply-${application.id}.pdf`);
    await writeFile(cvPdfPath, pdfBuffer);

    const context = await this.browserSession.createContext(sessionState);
    try {
      const page = await context.newPage();
      const result = await applier.apply(page, {
        application: {
          id: application.id,
          jobTitle: application.jobTitle,
          company: application.company,
          sourceUrl: application.sourceUrl,
        },
        cv,
        cvPdfPath,
        coverLetter: application.coverLetter,
        credential,
        knownAnswers,
        reportUnknownFields: (fields) =>
          this.customQuestions.recordUnknown(
            userId,
            fields.map((f) => ({ ...f, platform: platformKey, sourceUrl: application.sourceUrl })),
          ),
      });

      // Belt-and-braces: even if an applier's own error branch didn't call
      // `reportUnknownFields` itself, a failed attempt often still leaves
      // the invalid field(s) visible on the page — catch those too so no
      // blocking question goes unrecorded.
      if (!result.success) {
        await this.captureUnknownFields(page, platformKey, application.sourceUrl, userId);
      }

      if (platform) {
        try {
          const newState = await context.storageState();
          await this.credentials.saveSessionState(userId, platform, JSON.stringify(newState));
        } catch (error: any) {
          this.logger.warn(`Failed to persist session state for ${platform}: ${error.message}`);
        }
      }

      return result;
    } finally {
      await context.close().catch(() => {});
      await unlink(cvPdfPath).catch(() => {});
    }
  }

  private async captureUnknownFields(page: Page, platformKey: string, sourceUrl: string, userId: string): Promise<void> {
    try {
      const fields = await scanInvalidFields(page);
      if (fields.length) {
        await this.customQuestions.recordUnknown(
          userId,
          fields.map((f) => ({ ...f, platform: platformKey, sourceUrl })),
        );
      }
    } catch (error: any) {
      this.logger.warn(`Failed to scan for unknown fields: ${error.message}`);
    }
  }
}
