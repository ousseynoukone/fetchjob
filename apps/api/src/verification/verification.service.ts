import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import type { Page } from 'playwright';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { PlatformCredentialsService } from '../platform-credentials/platform-credentials.service';
import { SUPPORTED_PLATFORMS, SupportedPlatform } from '../platform-credentials/dto/upsert-credential.dto';
import { BrowserSessionService } from '../auto-apply/browser-session.service';
import {
  dismissCookieBanner,
  hasSecurityCheck,
  hasAlreadyAppliedIndicator,
  blockHeavyResources,
  normalizeLinkedInUrl,
} from '../auto-apply/appliers/ats-common';

// Confirmed live via a captured screenshot: HelloWork's own "vous avez déjà
// postulé..." message only appears as a reaction to actually starting the
// apply flow again — it never shows on the job posting page itself, which
// is all hasAlreadyAppliedIndicator's passive page.goto()+text-check could
// ever see. Clicking each platform's own "reveal the apply form" button
// (never proceeding to fill or submit anything) is what surfaces it. Not
// attempted for LinkedIn/Indeed — no live confirmation yet that clicking is
// necessary (or safe) there; passive text-checking stays the only method
// until there's real evidence either way.
const REVEAL_APPLY_BUTTON_TEXT: Partial<Record<string, RegExp>> = {
  hellowork: /^postuler/i,
  france_travail: /^postuler/i,
};

export interface VerificationStreamEvent {
  runId: string;
  type: 'log' | 'done';
  message: string;
  at: string;
}

// A manually-launched pass, separate from auto-apply itself: revisits every
// "applied" candidature that isn't confirmed yet, on its own offer page,
// using the platform's stored session — an independent check that the
// platform actually recorded the application, rather than trusting whatever
// the apply flow displayed on screen at the time. Only the four
// account-based platforms are checkable this way (ATS-hosted postings and
// aggregators don't have a "my applications" state to read without a login
// tied to that specific system).
//
// Also revisits every "needs_review" candidature on those same platforms —
// not just to double-check a reported success, but to catch the opposite,
// equally real failure mode: the apply flow itself misjudging a genuine
// success as blocked (confirmed live: an AI-driven action that WAS the real
// final submit got labeled "next" rather than "submit", so the code never
// checked for the confirmation text and reported "needs_review" for an
// application HelloWork had actually already recorded). A "needs_review"
// row confirmed here is promoted to "applied" — the campaign's own send
// counter is incremented the same way a normal successful auto-apply
// attempt would, so it isn't left permanently under-counted just because
// the mistake happened at report time rather than submission time.
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  private running = false;
  private readonly logStream = new Subject<VerificationStreamEvent>();

  constructor(
    private prisma: PrismaService,
    private localUser: LocalUserService,
    private credentials: PlatformCredentialsService,
    private browserSession: BrowserSessionService,
  ) {}

  streamLogs(): Observable<VerificationStreamEvent> {
    return this.logStream.asObservable();
  }

  async getLatestRun() {
    const userId = await this.localUser.getDefaultUserId();
    return this.prisma.verificationRun.findFirst({ where: { userId }, orderBy: { startedAt: 'desc' } });
  }

  async getRunHistory() {
    const userId = await this.localUser.getDefaultUserId();
    return this.prisma.verificationRun.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
  }

  async run() {
    if (this.running) return this.getLatestRun();
    const userId = await this.localUser.getDefaultUserId();

    const verificationRun = await this.prisma.verificationRun.create({
      data: { userId, logs: ['Vérification démarrée'] },
    });

    this.running = true;
    this.executeRun(verificationRun.id, userId).catch((error: any) => {
      this.logger.error(`Verification run ${verificationRun.id} crashed: ${error.message}`);
    });

    return verificationRun;
  }

  private async appendLog(runId: string, message: string) {
    const run = await this.prisma.verificationRun.findUnique({ where: { id: runId } });
    const logs = [...(run?.logs || []), message];
    await this.prisma.verificationRun.update({ where: { id: runId }, data: { logs } });
    this.logStream.next({ runId, type: 'log', message, at: new Date().toISOString() });
  }

  private async executeRun(runId: string, userId: string) {
    let checked = 0;
    let confirmed = 0;
    let unconfirmed = 0;

    try {
      // Capped, not "every matching row at once" — this app runs a single
      // shared Chromium instance inside a 512MB container (confirmed live:
      // an OOM crash), so an unbounded backlog (every "needs_review" row
      // ever accumulated, now also in scope) risks exceeding that regardless
      // of any one-page-at-a-time leak. Oldest-checked-first so repeated
      // runs make steady progress through a large backlog instead of
      // re-picking the same newest rows every time.
      const MAX_PER_RUN = 15;
      const applications = await this.prisma.application.findMany({
        where: {
          userId,
          status: { in: ['applied', 'needs_review'] },
          verifiedAt: null,
          jobOffer: { source: { in: [...SUPPORTED_PLATFORMS] } },
        },
        include: { jobOffer: true },
        orderBy: { updatedAt: 'asc' },
        take: MAX_PER_RUN,
      });

      if (!applications.length) {
        await this.appendLog(
          runId,
          "Rien à vérifier : aucune candidature 'envoyée' ou 'à vérifier' en attente de confirmation sur une plateforme vérifiable (LinkedIn, Indeed, France Travail, HelloWork).",
        );
        await this.finishRun(runId, { checked, confirmed, unconfirmed });
        return;
      }

      const byPlatform = new Map<string, typeof applications>();
      for (const application of applications) {
        const list = byPlatform.get(application.jobOffer.source) || [];
        list.push(application);
        byPlatform.set(application.jobOffer.source, list);
      }

      for (const [platform, apps] of byPlatform) {
        let sessionState: string | null = null;
        try {
          sessionState = (await this.credentials.getDecrypted(userId, platform as SupportedPlatform)).sessionState;
        } catch {
          await this.appendLog(runId, `${platform} : aucune session établie — ${apps.length} candidature(s) ignorée(s).`);
          continue;
        }
        if (!sessionState) {
          await this.appendLog(runId, `${platform} : session expirée — ${apps.length} candidature(s) ignorée(s).`);
          continue;
        }

        const context = await this.browserSession.createContext(sessionState);
        await blockHeavyResources(context);
        try {
          for (const application of apps) {
            checked++;
            const label = `${application.jobTitle} chez ${application.company}`;
            // Declared outside the try so the finally block below can always
            // close it — confirmed live as a real container-OOM cause: on an
            // error (a stale job URL, a navigation timeout, ...) execution
            // jumped straight to the catch block, which never closed the
            // page, leaking a whole Chromium tab per failed check. Harmless
            // at a handful of "applied" rows; became a real crash the moment
            // this run started also covering the much larger "needs_review"
            // backlog, where more rows genuinely fail to load.
            let page: Page | null = null;
            try {
              page = await context.newPage();
              // Confirmed live: a stored sourceUrl on LinkedIn's own locale
              // subdomain (fr.linkedin.com, ...) throws
              // ERR_TOO_MANY_REDIRECTS with a stored session cookie — the
              // same bug already fixed in linkedin.applier.ts's own
              // navigation, which this call site never shared.
              await page.goto(normalizeLinkedInUrl(application.sourceUrl), { waitUntil: 'domcontentloaded', timeout: 30000 });
              await dismissCookieBanner(page);

              // See REVEAL_APPLY_BUTTON_TEXT — the "already applied" message
              // on some platforms only shows reactively, never on the job
              // page itself. Stops at revealing the form; never fills or
              // submits anything, so this can't produce a real duplicate
              // application.
              const revealButtonText = REVEAL_APPLY_BUTTON_TEXT[platform];
              if (revealButtonText) {
                const revealButton = page.getByRole('button', { name: revealButtonText }).or(page.getByRole('link', { name: revealButtonText })).first();
                if (await revealButton.isVisible().catch(() => false)) {
                  await revealButton.click().catch(() => {});
                  await page.waitForTimeout(1500);
                }
              }

              // Captured for every check, confirmed or not — the only way
              // to tell a real detection gap (hasAlreadyAppliedIndicator's
              // text patterns were never verified against a real logged-in
              // session) apart from a genuine non-recording, instead of
              // guessing from the note text alone.
              await this.captureVerificationScreenshot(page, application.id);

              if (await hasSecurityCheck(page)) {
                unconfirmed++;
                await this.prisma.application.update({
                  where: { id: application.id },
                  data: { verificationNote: 'Vérification impossible : contrôle de sécurité affiché par la plateforme.' },
                });
                await this.appendLog(runId, `${label} : contrôle de sécurité, vérification impossible.`);
              } else if (await hasAlreadyAppliedIndicator(page)) {
                confirmed++;
                if (application.status === 'needs_review') {
                  // The platform actually recorded this one — promote it the
                  // same way a normal successful auto-apply attempt would,
                  // counter included, instead of leaving it stuck on a wrong
                  // "needs_review" status forever.
                  await this.prisma.$transaction([
                    this.prisma.application.update({
                      where: { id: application.id },
                      data: {
                        status: 'applied',
                        appliedAt: application.appliedAt ?? new Date(),
                        autoApplyNote: null,
                        verifiedAt: new Date(),
                        verificationNote: null,
                      },
                    }),
                    this.prisma.campaign.update({
                      where: { id: application.campaignId },
                      data: { totalApplicationsSent: { increment: 1 } },
                    }),
                  ]);
                  await this.appendLog(runId, `Confirmé et mis à jour (à vérifier → envoyée) : ${label}`);
                } else {
                  await this.prisma.application.update({
                    where: { id: application.id },
                    data: { verifiedAt: new Date(), verificationNote: null },
                  });
                  await this.appendLog(runId, `Confirmé : ${label}`);
                }
              } else {
                unconfirmed++;
                // A "needs_review" row already carries its own explanation
                // in autoApplyNote — leave it alone (and leave verifiedAt
                // null so it's checked again next run) instead of
                // overwriting it with a generic verification note.
                if (application.status !== 'needs_review') {
                  await this.prisma.application.update({
                    where: { id: application.id },
                    data: {
                      verificationNote:
                        "Aucune confirmation détectée sur la page de l'offre — à vérifier manuellement.",
                    },
                  });
                }
                await this.appendLog(runId, `Non confirmé : ${label}`);
              }
            } catch (error: any) {
              unconfirmed++;
              await this.appendLog(runId, `Erreur en vérifiant ${label} : ${error.message}`);
            } finally {
              if (page) await page.close().catch(() => {});
            }

            await this.browserSession.randomDelay(2000, 5000);
          }
        } finally {
          await context.close().catch(() => {});
        }
      }

      const moreRemaining = checked >= MAX_PER_RUN ? ' Il en reste peut-être davantage — relancez une vérification pour continuer.' : '';
      await this.appendLog(
        runId,
        `Terminé : ${checked} vérifiée(s), ${confirmed} confirmée(s), ${unconfirmed} non confirmée(s).${moreRemaining}`,
      );
      await this.finishRun(runId, { checked, confirmed, unconfirmed });
    } catch (error: any) {
      this.logger.error(error);
      await this.appendLog(runId, `Erreur : ${error.message}`);
      await this.prisma.verificationRun.update({
        where: { id: runId },
        data: { finishedAt: new Date(), error: error.message, checked, confirmed, unconfirmed },
      });
      this.running = false;
      this.logStream.next({ runId, type: 'done', message: error.message, at: new Date().toISOString() });
    }
  }

  private async finishRun(runId: string, stats: { checked: number; confirmed: number; unconfirmed: number }) {
    await this.prisma.verificationRun.update({ where: { id: runId }, data: { finishedAt: new Date(), ...stats } });
    this.running = false;
    this.logStream.next({ runId, type: 'done', message: '', at: new Date().toISOString() });
  }

  // Mirrors AutoApplyService's own captureScreenshot — same format/quality,
  // separate DB field (see schema.prisma) since this captures a different
  // moment than the apply-time one.
  private async captureVerificationScreenshot(page: Page, applicationId: string): Promise<void> {
    try {
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      await this.prisma.application.update({
        where: { id: applicationId },
        data: { verificationScreenshot: screenshot, verificationScreenshotTakenAt: new Date() },
      });
    } catch (error: any) {
      this.logger.warn(`Failed to capture verification screenshot for ${applicationId}: ${error.message}`);
    }
  }
}
