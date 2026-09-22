import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { CvService } from '../cv/cv.service';
import { PdfService } from '../pdf/pdf.service';
import { PlatformCredentialsService } from '../platform-credentials/platform-credentials.service';
import { SUPPORTED_PLATFORMS, SupportedPlatform } from '../platform-credentials/dto/upsert-credential.dto';
import { BrowserSessionService } from './browser-session.service';
import { LinkedInApplier } from './appliers/linkedin.applier';
import { IndeedApplier } from './appliers/indeed.applier';
import { FranceTravailApplier } from './appliers/france-travail.applier';
import { HelloWorkApplier } from './appliers/hellowork.applier';
import { WelcomeToTheJungleApplier } from './appliers/wttj.applier';
import { ApecApplier } from './appliers/apec.applier';
import { GreenhouseApplier } from './appliers/greenhouse.applier';
import { LeverApplier } from './appliers/lever.applier';
import { WorkdayApplier } from './appliers/workday.applier';
import { SmartRecruitersApplier } from './appliers/smartrecruiters.applier';
import { FreeWorkApplier } from './appliers/freework.applier';
import { GenericApplier } from './appliers/generic.applier';
import { JobApplier, ApplyResult } from './appliers/applier.interface';
import { scanInvalidFields } from './appliers/form-fields';
import { resolveWelcomeToTheJungleApplyUrl, blockHeavyResources } from './appliers/ats-common';
import { CustomQuestionsService } from '../custom-questions/custom-questions.service';
import type { CVData } from '../pdf/templates/cv-document';
import type { Page, BrowserContext, CDPSession } from 'playwright';

// Matched against `sourceUrl`'s hostname regardless of which source scraped
// the offer (Adzuna, Remotive, The Muse... are aggregators that redirect to
// whatever the employer actually uses) — these four ATS platforms cover a
// large share of company career sites, so detecting them by URL catches far
// more real candidatures than a per-aggregator applier ever could.
// Used when the "autoApplyMaxAiCalls" setting is unset or invalid — same
// fallback-constant pattern as DigestService's DEFAULT_INTERVAL_HOURS.
const DEFAULT_MAX_AI_CALLS_PER_ATTEMPT = 3;

// Only strips characters that would actually break a filename on disk or in
// an upload — keeps the name itself fully intact and readable.
function sanitizeCvFileName(fullName: string): string {
  const firstOnly = (fullName || '').split(' ')[0];
  const cleaned = (firstOnly || '').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || 'CV';
}

const ATS_HOST_PATTERNS: { pattern: RegExp; key: string }[] = [
  { pattern: /(^|\.)greenhouse\.io$/i, key: 'greenhouse' },
  { pattern: /(^|\.)lever\.co$/i, key: 'lever' },
  { pattern: /myworkdayjobs\.com$/i, key: 'workday' },
  { pattern: /(^|\.)smartrecruiters\.com$/i, key: 'smartrecruiters' },
  // Confirmed live via a real recorded application: a normal, no-account
  // apply flow (see freework.applier.ts) -- routed by URL like the other
  // ATS-by-domain entries above, so an Adzuna/Indeed/France Travail listing
  // that happens to link here gets the real, working flow instead of the
  // generic fallback's guess (which used to misread it as account-only).
  { pattern: /(^|\.)free-work\.com$/i, key: 'free_work' },
];

function detectAtsKey(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    return ATS_HOST_PATTERNS.find(({ pattern }) => pattern.test(hostname))?.key || null;
  } catch {
    return null;
  }
}

// Only France Travail actually needs this: it aggregates postings from
// partner sites, so a `sourceUrl` scraped under source 'france_travail' can
// point at some employer's own external page instead of francetravail.fr
// itself (see ScrapingService's `origineOffre.urlOrigine`). LinkedIn/Indeed/
// HelloWork sourceUrls are always constructed on their own domain, so they
// have no entry here and are never second-guessed.
const SOURCE_OWN_DOMAIN: Partial<Record<string, RegExp>> = {
  france_travail: /(^|\.)francetravail\.fr$/i,
  // Confirmed live (Webnet): a WTTJ offer whose apply URL was pre-resolved
  // to taleez.com was still handed to the WTTJ applier, which then had
  // nothing to do on a foreign page but hand the same URL back.
  welcome_to_the_jungle: /(^|\.)welcometothejungle\.com$/i,
  hellowork: /(^|\.)hellowork\.com$/i,
  apec: /(^|\.)apec\.fr$/i,
  indeed: /(^|\.)indeed\.com$/i,
  linkedin: /(^|\.)linkedin\.com$/i,
};

// A redirect that lands on one of the account-based platforms (confirmed
// live: an Adzuna ad bouncing to an apec.fr offer) belongs to that
// platform's own applier, with that platform's stored session -- not to
// the generic fallback, which has neither the session nor the flow.
const PLATFORM_BY_HOST: { pattern: RegExp; platform: string }[] = [
  { pattern: /(^|\.)apec\.fr$/i, platform: 'apec' },
  { pattern: /(^|\.)hellowork\.com$/i, platform: 'hellowork' },
  { pattern: /(^|\.)welcometothejungle\.com$/i, platform: 'welcome_to_the_jungle' },
  { pattern: /(^|\.)francetravail\.fr$/i, platform: 'france_travail' },
  { pattern: /(^|\.)indeed\.com$/i, platform: 'indeed' },
  { pattern: /(^|\.)linkedin\.com$/i, platform: 'linkedin' },
];

function platformForHost(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return PLATFORM_BY_HOST.find((entry) => entry.pattern.test(host))?.platform || null;
  } catch {
    return null;
  }
}

function matchesOwnDomain(source: string, sourceUrl: string): boolean {
  const pattern = SOURCE_OWN_DOMAIN[source];
  if (!pattern) return true;
  try {
    return pattern.test(new URL(sourceUrl).hostname);
  } catch {
    return false;
  }
}

export interface AutoApplyRunResult {
  applied: number;
  needsReview: number;
  // True if a pause request cut the run short — the remaining
  // applicationIds were never attempted (left at `to_apply`, not touched).
  cancelled: boolean;
}

@Injectable()
export class AutoApplyService {
  private readonly logger = new Logger(AutoApplyService.name);
  private readonly appliers: Record<string, JobApplier>;

  private readonly atsAppliers: Record<string, JobApplier>;

  // Live view of whatever the headless browser is currently rendering
  // during an apply attempt — a CDP screencast (Page.startScreencast),
  // not a saved video file: frames are pushed here the moment Chromium
  // produces them and never persisted, purely for watching a run happen.
  // `dataUrl: null` marks "nothing live right now" (an attempt just
  // finished and its browser context closed) — without it the frontend
  // just keeps showing the last frame from whichever candidature finished,
  // which looks exactly like a frozen/hung run during the (often several
  // minutes long) delay before the next attempt starts.
  private readonly frameStream = new Subject<{ applicationId: string; dataUrl: string | null }>();

  streamFrames(): Observable<{ applicationId: string; dataUrl: string | null }> {
    return this.frameStream.asObservable();
  }

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private cvService: CvService,
    private pdfService: PdfService,
    private credentials: PlatformCredentialsService,
    private browserSession: BrowserSessionService,
    private customQuestions: CustomQuestionsService,
    linkedin: LinkedInApplier,
    indeed: IndeedApplier,
    franceTravail: FranceTravailApplier,
    helloWork: HelloWorkApplier,
    wttj: WelcomeToTheJungleApplier,
    apec: ApecApplier,
    greenhouse: GreenhouseApplier,
    lever: LeverApplier,
    workday: WorkdayApplier,
    smartRecruiters: SmartRecruitersApplier,
    freeWork: FreeWorkApplier,
    private genericFallback: GenericApplier,
  ) {
    this.appliers = {
      linkedin,
      indeed,
      france_travail: franceTravail,
      hellowork: helloWork,
      welcome_to_the_jungle: wttj,
      apec: apec,
    };
    this.atsAppliers = {
      greenhouse,
      lever,
      workday,
      smartrecruiters: smartRecruiters,
      free_work: freeWork,
    };
  }

  // URL-based ATS detection takes priority: an Adzuna/Remotive/The Muse/...
  // listing that happens to link to a Greenhouse/Lever/Workday/SmartRecruiters
  // posting has a real form to drive there, regardless of which source
  // scraped it — the source-keyed appliers below only cover offers actually
  // hosted on that platform's own domain. `atsEnabled` lets a campaign opt
  // out of ATS-based submission independently of the account-based platforms.
  //
  // Falling through to the generic best-effort applier (rather than giving
  // up) covers two cases: a source with no dedicated applier at all
  // (Adzuna, Remotive, manual offers, ...), and a source whose applier
  // exists but doesn't own this particular URL (France Travail aggregating
  // a posting hosted on some employer's own site — see matchesOwnDomain).
  private getApplier(source: string, sourceUrl: string, atsEnabled: boolean): { applier: JobApplier; platformKey: string } {
    if (atsEnabled) {
      const atsKey = detectAtsKey(sourceUrl);
      if (atsKey && this.atsAppliers[atsKey]) return { applier: this.atsAppliers[atsKey], platformKey: atsKey };
    }
    if (this.appliers[source] && matchesOwnDomain(source, sourceUrl)) {
      return { applier: this.appliers[source], platformKey: source };
    }
    return { applier: this.genericFallback, platformKey: source };
  }

  // Used only for a URL an applier discovered mid-flow (ApplyResult.
  // redirectToExternalUrl — LinkedIn/Indeed/HelloWork postings with no
  // in-platform apply flow) — deliberately never falls back to a
  // source-keyed applier the way getApplier() does: that source's applier
  // is exactly what just gave up on this URL, so retrying it would loop.
  private getApplierForResolvedUrl(url: string, atsEnabled: boolean, excludePlatform?: string): { applier: JobApplier; platformKey: string } {
    if (atsEnabled) {
      const atsKey = detectAtsKey(url);
      if (atsKey && this.atsAppliers[atsKey]) return { applier: this.atsAppliers[atsKey], platformKey: atsKey };
    }
    // Never the platform applier that just handed this URL off (it would
    // loop), but any OTHER account-based platform owns its own domain.
    const platform = platformForHost(url);
    if (platform && platform !== excludePlatform && this.appliers[platform]) {
      return { applier: this.appliers[platform], platformKey: platform };
    }
    return { applier: this.genericFallback, platformKey: 'external' };
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
    // Checked before each candidature and again after the between-candidature
    // delay — a pause request otherwise wouldn't take effect until the whole
    // list (each one 45-150s apart by default) finished on its own.
    isCancelled?: () => boolean;
    sourceDailyLimits?: Record<string, number>;
    maxApplicationsPerDay?: number;
  }): Promise<AutoApplyRunResult> {
    const { userId, applicationIds, atsEnabled, appendLog, isCancelled } = params;
    const minDelaySeconds = Math.min(params.minDelaySeconds, params.maxDelaySeconds);
    const maxDelaySeconds = Math.max(params.minDelaySeconds, params.maxDelaySeconds);
    // Loaded once for the whole run rather than per candidature — a
    // question answered mid-run should still only need answering once.
    const knownAnswers = await this.customQuestions.getKnownAnswers(userId);
    const maxAiCallsRaw = await this.settings.get('autoApplyMaxAiCalls');
    const maxAiCallsPerAttempt =
      Number(maxAiCallsRaw) >= 0 ? Number(maxAiCallsRaw) : DEFAULT_MAX_AI_CALLS_PER_ATTEMPT;
    let applied = 0;
    let needsReview = 0;
    const expiredPlatforms = new Set<string>();
    const wafBlockedPlatforms = new Set<string>();

    for (let i = 0; i < applicationIds.length; i++) {
      if (isCancelled?.()) {
        return { applied, needsReview, cancelled: true };
      }

      const applicationId = applicationIds[i];
      const application = await this.prisma.application.findUnique({
        where: { id: applicationId },
        include: { jobOffer: true },
      });
      if (!application) continue;

      const source = application.jobOffer?.source || 'unknown';

      if (wafBlockedPlatforms.has(source)) {
        needsReview++;
        await this.prisma.application.update({
          where: { id: applicationId },
          data: {
            status: 'needs_review',
            autoApplyNote: `${source} a refusé l'accès (blocage WAF/403) plus tôt dans cette série — reportée, à relancer plus tard.`,
          },
        });
        await appendLog(`Candidature reportée pour ${application.jobTitle} chez ${application.company} : ${source} bloque l'accès (403) pour le moment.`);
        continue;
      }

      if (expiredPlatforms.has(source)) {
        needsReview++;
        await this.prisma.application.update({
          where: { id: applicationId },
          data: {
            status: 'needs_review',
            autoApplyNote: `Session ${source} expirée — ignorée pour cette série. Reconnectez-vous depuis la page Comptes.`,
          },
        });
        await appendLog(
          `Candidature ignorée pour ${application.jobTitle} chez ${application.company} : la session ${source} est expirée.`,
        );
        continue;
      }

      const configuredLimit = params.sourceDailyLimits?.[source];
      const dailyLimit =
        configuredLimit !== undefined && configuredLimit > 0
          ? configuredLimit
          : (params.maxApplicationsPerDay || 0);

      if (dailyLimit > 0) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        // Only confirmed applications (status: 'applied') count against the limit.
        // If an offer is 'needs_review' (à vérifier), it does NOT count.
        const confirmedToday = await this.prisma.application.count({
          where: {
            campaignId: application.campaignId,
            status: 'applied',
            appliedAt: { gte: startOfDay },
            jobOffer: { source },
          },
        });

        if (confirmedToday >= dailyLimit) {
          await appendLog(
            `Quota quotidien de candidatures confirmées atteint pour ${source} (${confirmedToday}/${dailyLimit} confirmées sans doute). Offre ignorée pour aujourd'hui.`,
          );
          continue;
        }
      }

      try {
        await appendLog(`Auto-apply en cours : ${application.jobTitle} chez ${application.company}...`);
        const result = await this.applyToOne(userId, application, atsEnabled, knownAnswers, maxAiCallsPerAttempt, appendLog);
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
          const failedPlatform = (result as { actualPlatform?: string }).actualPlatform || source;
          if (result.blockedByWaf) {
            wafBlockedPlatforms.add(failedPlatform);
            await appendLog(`⚠️ ${failedPlatform} refuse l'accès (403) : les autres offres ${failedPlatform} de cette série sont reportées pour ne pas aggraver le blocage.`);
          }
          if (result.sessionExpired) {
            expiredPlatforms.add(failedPlatform);
            await appendLog(
              `⚠️ Session ${failedPlatform} expirée : toutes les autres offres ${failedPlatform} de cette série seront ignorées pour protéger votre compte.`,
            );
          }
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

      // The browser context for this candidature is already closed by now
      // (see applyToOne's finally block) — clear the live view rather than
      // leaving its last frame on screen for the whole delay that follows.
      this.frameStream.next({ applicationId, dataUrl: null });

      if (i < applicationIds.length - 1) {
        await this.browserSession.randomDelay(minDelaySeconds * 1000, maxDelaySeconds * 1000);
        if (isCancelled?.()) {
          return { applied, needsReview, cancelled: true };
        }
      }
    }

    return { applied, needsReview, cancelled: false };
  }

  // Welcome to the Jungle hosts the posting but rarely the actual apply
  // form — the real target only appears as a link on the rendered page (see
  // resolveWelcomeToTheJungleApplyUrl). Resolved once, in a disposable
  // context, before the ATS-by-URL routing below ever runs: `sourceUrl`
  // as stored is WTTJ's own page, so detecting greenhouse.io/lever.co/etc.
  // against it directly would never match.
  private async resolveEffectiveSourceUrl(source: string, sourceUrl: string): Promise<string> {
    if (source !== 'welcome_to_the_jungle') return sourceUrl;

    const context = await this.browserSession.createContext(null, 'welcome_to_the_jungle');
    try {
      await blockHeavyResources(context);
      const page = await context.newPage();
      const resolved = await resolveWelcomeToTheJungleApplyUrl(page, sourceUrl);
      return resolved || sourceUrl;
    } catch (error: any) {
      this.logger.warn(`Welcome to the Jungle apply-link resolution failed for ${sourceUrl}: ${error.message}`);
      return sourceUrl;
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async applyToOne(
    userId: string,
    application: {
      id: string;
      jobTitle: string;
      company: string;
      sourceUrl: string;
      coverLetter: string | null;
      jobOffer: { source: string; description: string; url: string };
    },
    atsEnabled: boolean,
    knownAnswers: Map<string, string>,
    maxAiCallsPerAttempt: number,
    appendLog?: (message: string) => Promise<void>,
  ) {
    const effectiveSourceUrl = await this.resolveEffectiveSourceUrl(application.jobOffer.source, application.sourceUrl);
    const { applier, platformKey } = this.getApplier(application.jobOffer.source, effectiveSourceUrl, atsEnabled);
    const platform = applier.credentialPlatform as SupportedPlatform | null;

    let sessionState: string | null = null;
    let decryptedCred: any = null;
    if (platform && (SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
      try {
        decryptedCred = await this.credentials.getDecrypted(userId, platform);
        sessionState = decryptedCred.sessionState;
      } catch {
        // No session established yet — the applier will hit its login wall
        // and report a clear "session expired/missing" note on its own.
      }
    }

    const cv = await this.buildCvData(application.id, userId);
    const pdfBuffer = await this.pdfService.generateCVPdf(cv);
    // The temp file itself keeps an id-based name (avoids any cross-attempt
    // collision) — the filename actually shown to the platform/recruiter is
    // set separately at upload time (see ats-common.ts's uploadCv) using the
    // candidate's own name instead.
    const cvPdfPath = join(tmpdir(), `findurjob-auto-apply-${application.id}.pdf`);
    await writeFile(cvPdfPath, pdfBuffer);
    const cvFileName = `${sanitizeCvFileName(cv.fullName)} - CV.pdf`;

    const context = await this.browserSession.createContext(sessionState, platformKey);
    let cdpSession: CDPSession | null = null;

    // Confirmed live: one HelloWork attempt sat past its normal completion
    // point and never advanced to the next candidature, blocking the whole
    // run indefinitely — no single applier step here has an unconditional
    // wait, but this guarantees the *loop* can never actually get stuck
    // again regardless of what causes a given attempt to stall.
    //
    // Two independent layers, not just one: force-closing the context is
    // the "normal" way this interrupts a stuck attempt (any Playwright call
    // still in flight on a closed context is supposed to reject immediately
    // once the underlying browser acknowledges the close). But confirmed
    // live that this alone isn't bulletproof — a stuck attempt sat idle
    // (0% CPU, no crash) for over two hours, well past this same timeout,
    // with neither this warning nor the eventual rejection ever happening
    // (most likely explanation: the host machine/Docker VM was suspended
    // partway through, which can leave an in-flight browser-protocol call
    // and even its own watchdog timer in limbo on resume). raceForResult()
    // below adds a second, independent timer that doesn't depend on
    // anything about *why* apply() is stuck — it just stops waiting on it
    // after the same budget and reports a failure either way, so the run()
    // loop is guaranteed to move on to the next candidature regardless.
    // Per HOP, not per attempt (see armWatchdog): a source-platform offer
    // that redirects to an employer ATS is two full page flows -- confirmed
    // live on France Travail -> Direct Emploi, where the 120s shared budget
    // ran out with the second form half-filled (a dozen fields, selects,
    // a CV upload and the AI planning rounds each take real seconds), and
    // the redirected form is also the one with the most to do.
    const APPLY_TIMEOUT_MS = 150_000;
    const TIMEOUT_NOTE = `Tentative interrompue après ${APPLY_TIMEOUT_MS / 1000}s sans réponse — à vérifier manuellement.`;
    // Set synchronously, before context.close() is even called -- lets the
    // race below tell "we deliberately killed this" apart from a genuine,
    // unrelated crash (see the .catch() on `pending`).
    let timedOut = false;
    const onWatchdogFired = () => {
      this.logger.warn(`Auto-apply attempt for ${application.id} exceeded ${APPLY_TIMEOUT_MS / 1000}s — forcing it to stop.`);
      timedOut = true;
      // Screenshotted BEFORE closing, not after -- confirmed live that a
      // screenshot attempted after context.close() always fails silently
      // (the whole context, every tab, is gone), leaving whatever
      // screenshot happened to be saved from a PREVIOUS, unrelated attempt
      // still sitting in the DB. That made a genuinely-stuck attempt look
      // like nothing had even started, with no way to tell what it was
      // actually stuck on. Bounded to 5s of its own so a truly hung page
      // can't delay the close this exists to force in the first place.
      const lastPage = context.pages().at(-1);
      const timeoutScreenshot = lastPage
        ? this.captureScreenshot(lastPage, application.id, 5000)
        : Promise.resolve();
      timeoutScreenshot.finally(() => {
        context.close().catch(() => {});
      });
    };
    let timeoutHandle = setTimeout(onWatchdogFired, APPLY_TIMEOUT_MS);
    // Re-arms the watchdog with a fresh budget for the next hop.
    const armWatchdog = () => {
      clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(onWatchdogFired, APPLY_TIMEOUT_MS);
    };

    // Set once the race times out — a browser that's unresponsive enough to
    // stall apply() this way is presumed unresponsive for anything else
    // touching the same page/context too (confirmed live: the very next
    // operation after a timed-out apply(), a plain screenshot, hung the
    // exact same way). Every step below checks this before touching the
    // page again instead of finding out the hard way one call at a time.
    let unresponsive = false;

    // The second timer used to be a bare setTimeout inside a Promise that
    // was never cleared: it fired 120s after EVERY attempt started, long
    // after most had finished, logging a bogus "timed out at the
    // orchestrator level" for each one (confirmed live: seven in a row on
    // attempts that took under a minute) and, worse, flipping
    // `unresponsive` to true while a redirect hop was still running --
    // which then skipped that hop's screenshot and session save. Cleared
    // as soon as the real result settles.
    const raceForResult = (pending: Promise<ApplyResult>): Promise<ApplyResult> => {
      let orchestratorTimer: NodeJS.Timeout | undefined;
      return Promise.race([
        // The "normal" half of the two-layer timeout above: once
        // context.close() has fired, whatever Playwright call is still in
        // flight inside `pending` is EXPECTED to reject with a raw,
        // confusing error ("Target page, context or browser has been
        // closed") -- confirmed live this exact raw error was leaking
        // straight through to the user as the application's failure note,
        // on every attempt that hit this timeout via its normal, working
        // path (the second timer below only ever caught the rare
        // stuck-even-after-close case this was originally added for). A
        // genuine error unrelated to the timeout still propagates as-is,
        // since `timedOut` only ever becomes true after this file's own
        // close() call.
        pending.catch((err) => {
          if (timedOut) {
            unresponsive = true;
            return { success: false, note: TIMEOUT_NOTE };
          }
          throw err;
        }),
        new Promise<ApplyResult>((resolve) => {
          orchestratorTimer = setTimeout(() => {
            this.logger.warn(`Auto-apply attempt for ${application.id} timed out at the orchestrator level — abandoning it.`);
            unresponsive = true;
            resolve({ success: false, note: TIMEOUT_NOTE });
          }, APPLY_TIMEOUT_MS + 5_000);
        }),
      ]).finally(() => clearTimeout(orchestratorTimer));
    };

    // Bounds a cleanup step that itself touches the (possibly dead)
    // browser/context — used in the finally block below so a hung close()
    // or screenshot can't block the run() loop any more than the apply()
    // call itself could.
    const withCleanupTimeout = <T>(pending: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

    try {
      const page = await context.newPage();
      // Confirmed live on a Michael Page apply flow ("Postuler avec mon
      // CV"): that button opens the browser's native file picker. Left
      // unanswered, the picker sat open and every later action on the
      // page stalled until the 150s watchdog. Any file chooser opened on
      // any tab of this attempt gets the CV, which is also exactly what a
      // person would pick there.
      const answerFileChooser = (p: Page) =>
        p.on('filechooser', (chooser) => {
          chooser.setFiles({ name: cvFileName, mimeType: 'application/pdf', buffer: pdfBuffer }).catch(() => {});
        });
      answerFileChooser(page);
      context.on('page', answerFileChooser);
      cdpSession = await this.startScreencast(context, page, application.id);
      let finalUrl = effectiveSourceUrl;
      let finalPlatformKey = platformKey;
      let result = await raceForResult(applier.apply(page, {
        application: {
          id: application.id,
          jobTitle: application.jobTitle,
          company: application.company,
          sourceUrl: effectiveSourceUrl,
        },
        cv,
        cvPdfPath,
        cvFileName,
        coverLetter: application.coverLetter,
        knownAnswers,
        maxAiCallsPerAttempt,
        reportUnknownFields: (fields) =>
          this.customQuestions.recordUnknown(
            userId,
            fields.map((f) => ({ ...f, platform: finalPlatformKey, sourceUrl: finalUrl })),
          ),
        saveAnsweredFields: (fields) =>
          this.customQuestions.recordAnswered(
            userId,
            fields.map((f) => ({ ...f, platform: finalPlatformKey, sourceUrl: finalUrl })),
          ),
        appendLog,
        credential: decryptedCred ? { email: decryptedCred.email, password: decryptedCred.password } : null,
        onSessionUpdated: async (newSession: string) => {
          if (platform) {
            await this.credentials.saveSessionState(userId, platform, newSession);
          }
        },
      }));

      // The platform's own apply flow turned out not to exist for this
      // posting (LinkedIn/Indeed/HelloWork only discover this after
      // visiting the page) — one more hop to whichever applier actually
      // owns the resolved URL, instead of giving up on what the
      // source-keyed applier reported. Up to TWO hops: an aggregator
      // (Adzuna) lands on another board (HelloWork, Indeed...) whose own
      // apply then redirects to the employer's ATS -- confirmed live. A URL
      // already visited in this attempt ends the chain, so it can't loop.
      // Only URLs already followed as hops count as "visited": the starting
      // URL itself must stay eligible, since an applier can legitimately
      // hand back the very page it was given (confirmed live: the WTTJ
      // applier on a pre-resolved taleez.com URL) for another applier.
      const visitedHops = new Set<string>();
      for (let hop = 0; hop < 2 && !result.success && result.redirectToExternalUrl; hop++) {
        if (visitedHops.has(result.redirectToExternalUrl)) break;
        visitedHops.add(result.redirectToExternalUrl);
        finalUrl = result.redirectToExternalUrl;
        const redirected = this.getApplierForResolvedUrl(finalUrl, atsEnabled, finalPlatformKey);
        finalPlatformKey = redirected.platformKey;
        // The hop lands on another account-based platform: give the context
        // that platform's stored session, so its applier runs logged in.
        const hopPlatform = redirected.applier.credentialPlatform as SupportedPlatform | null;
        // Confirmed live (Free-Work via an Indeed hop): only cookies were
        // ever carried over here, never the plain email/password -- so an
        // applier that needs to log in INLINE mid-attempt (no stored
        // session yet, e.g. a first-ever run) always saw ctx.credential as
        // null/undefined and could never use a credential the person had
        // genuinely saved for that platform.
        let hopCredential: { email: string; password?: string | null } | null = null;
        if (hopPlatform && hopPlatform !== platform) {
          try {
            const hopCred = await this.credentials.getDecrypted(userId, hopPlatform);
            hopCredential = { email: hopCred.email, password: hopCred.password };
            const hopState = hopCred.sessionState ? JSON.parse(hopCred.sessionState) : null;
            const hopCookies = Array.isArray(hopState) ? hopState : Array.isArray(hopState?.cookies) ? hopState.cookies : [];
            if (hopCookies.length) {
              await context.addCookies(hopCookies).catch(() => {});
              await appendLog(`Session ${hopPlatform} chargée pour cette redirection.`);
            }
          } catch {
            // No stored credential/session for that platform: its applier reports the login wall itself.
          }
        }
        // Logged here, once, for every source: the run log otherwise jumps
        // straight from "en cours" to the verdict with no trace of WHERE the
        // attempt actually spent its time (confirmed live on a HelloWork ->
        // recruiter-site hop that timed out with a screenshot of the wrong tab).
        let redirectHost = finalUrl;
        try {
          redirectHost = new URL(finalUrl).hostname;
        } catch {}
        await appendLog(`Redirection vers ${redirectHost} (${redirected.platformKey})...`);
        armWatchdog();
        result = await raceForResult(redirected.applier.apply(page, {
          application: {
            id: application.id,
            jobTitle: application.jobTitle,
            company: application.company,
            sourceUrl: finalUrl,
          },
          cv,
          cvPdfPath,
          cvFileName,
          coverLetter: application.coverLetter,
          knownAnswers,
          maxAiCallsPerAttempt,
          reportUnknownFields: (fields) =>
            this.customQuestions.recordUnknown(
              userId,
              fields.map((f) => ({ ...f, platform: finalPlatformKey, sourceUrl: finalUrl })),
            ),
          saveAnsweredFields: (fields) =>
            this.customQuestions.recordAnswered(
              userId,
              fields.map((f) => ({ ...f, platform: finalPlatformKey, sourceUrl: finalUrl })),
            ),
          appendLog,
          credential: hopCredential,
        }));
      }

      // A redirect the hop budget didn't allow following is still an
      // honest outcome, not an "undefined" note.
      if (!result.success && result.redirectToExternalUrl && !result.note) {
        let host = result.redirectToExternalUrl;
        try {
          host = new URL(result.redirectToExternalUrl).hostname;
        } catch {}
        result = { ...result, note: `Redirection supplémentaire vers ${host} non suivie (limite de sauts atteinte) — à finaliser manuellement.` };
      }

      // Every one of these touches the same page/context the timed-out
      // apply() call was stuck on — confirmed live that a plain screenshot
      // hung the exact same way immediately after an orchestrator timeout,
      // so once the browser's shown itself unresponsive there's no reason
      // to expect any of these to behave any better. Skipped entirely
      // rather than attempted-and-hoping, since `result` from the race
      // already has a usable note either way.
      if (!unresponsive) {
        // Some appliers (see ApplyResult.finalPage) end up filling/
        // submitting the real form on a DIFFERENT page than the one they
        // were handed -- France Travail's native apply link opens in a new
        // tab via `target="_blank"`, confirmed live. Without this fallback,
        // every screenshot and unknown-field scan below kept running
        // against the original, now-irrelevant tab (still showing the job
        // listing) instead of the actual form the attempt ran on.
        const reportedPage = result.finalPage || page;

        // Every attempt, success or failure, leaves a screenshot — the only
        // record of what the page actually showed once the browser closes.
        await this.captureScreenshot(reportedPage, application.id);

        // Belt-and-braces: even if an applier's own error branch didn't call
        // `reportUnknownFields` itself, a failed attempt often still leaves
        // the invalid field(s) visible on the page — catch those too so no
        // blocking question goes unrecorded.
        if (!result.success) {
          await this.captureUnknownFields(reportedPage, finalPlatformKey, finalUrl, userId);
        }

        if (platform) {
          if (result.sessionExpired) {
            await this.credentials.recordSessionExpired(userId, platform).catch((error: any) => {
              this.logger.warn(`Failed to record expired session for ${platform}: ${error.message}`);
            });
          } else {
            // Confirmed live: persistContextCookies used to run unconditionally,
            // right above this branch, before this same sessionExpired check
            // existed for the DB-stored session state. A CAPTCHA/checkpoint hit
            // leaves the context holding only unauthenticated challenge-page
            // cookies (no li_at at all) — persisting those to disk here silently
            // overwrote the last known-good file, which then got layered on top
            // of every subsequent attempt's otherwise-valid session via
            // createContext()'s own addCookies(loadCookies(...)) call,
            // cascading one CAPTCHA hit into CAPTCHA hits on every following
            // LinkedIn attempt in the same run. Gated on the exact same
            // condition the DB-stored session state already correctly used.
            await this.browserSession.persistContextCookies(context, finalPlatformKey).catch(() => {});
            try {
              const newState = await context.storageState();
              if (platform === 'linkedin' && newState && Array.isArray(newState.cookies)) {
                newState.cookies = newState.cookies.filter((c: any) => c.domain && c.domain.includes('linkedin.com'));
              }
              await this.credentials.saveSessionState(userId, platform, JSON.stringify(newState));
            } catch (error: any) {
              this.logger.warn(`Failed to persist session state for ${platform}: ${error.message}`);
            }
          }
        }
      }

      // No per-candidature email here — DigestService reads `appliedAt`
      // directly off the Application table and sends a periodic summary
      // instead (see digest.service.ts).

      // finalPlatformKey, not the offer's original `source`: confirmed live
      // on an Indeed -> Free-Work hop, a Free-Work login failure came back
      // as `sessionExpired` and the run loop misattributed it to Indeed,
      // marking every OTHER Indeed offer in the same series as skippable
      // to "protect the account" -- an account that was never actually
      // touched. The circuit-breaker below needs to know which platform's
      // applier actually produced the verdict.
      return { ...result, actualPlatform: finalPlatformKey };
    } catch (error) {
      // The screenshot above only runs if execution REACHES it. An applier
      // that throws (a selector that never appeared, a navigation error, a
      // redirect loop, anything) rethrows out of raceForResult straight to
      // the finally below, which closes the context -- and the run() loop
      // then records `needs_review` with an error note and NO screenshot.
      // Confirmed live: every crashed attempt showed up as "à vérifier"
      // with nothing to look at, which is the one case a screenshot matters
      // most. Captured here, before the close, from whichever tab is last
      // (same choice the timeout handler makes -- picks up a finalPage
      // opened in a new tab). Skipped when the browser already proved
      // unresponsive: the timeout path took its own bounded screenshot,
      // and a second attempt on a dead browser would just hang.
      if (!unresponsive && !timedOut) {
        const lastPage = context.pages().at(-1);
        if (lastPage) await this.captureScreenshot(lastPage, application.id, 5000);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      // Bounded the same way as everything above — a hung close() on a
      // genuinely dead browser must not block the run() loop either.
      await withCleanupTimeout(this.stopScreencast(cdpSession), 10_000);
      await withCleanupTimeout(context.close(), 10_000).catch(() => {});
      await unlink(cvPdfPath).catch(() => {});
    }
  }

  // Chrome DevTools Protocol screencast — pushes JPEG frames of whatever
  // Chromium is actually rendering as it renders them, live, whether the
  // browser is headed or headless (this is exactly how remote-debugging
  // "live view" tools show a headless session; it needs no visible
  // display). Frames are relayed through frameStream and never saved
  // anywhere — this is a live view, not a recording.
  private async startScreencast(context: BrowserContext, page: Page, applicationId: string): Promise<CDPSession | null> {
    // Only capture and push screencast frames if an observer is actually listening
    if (!this.frameStream.observed) {
      return null;
    }
    try {
      const cdpSession = await context.newCDPSession(page);
      await cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 25,
        maxWidth: 700,
        maxHeight: 450,
        everyNthFrame: 15,
      });
      let lastSent = 0;
      cdpSession.on('Page.screencastFrame', (frame: any) => {
        const now = Date.now();
        // Emit at most 1 frame per 2 seconds to prevent memory exhaustion in Docker
        if (now - lastSent >= 2000) {
          lastSent = now;
          this.frameStream.next({ applicationId, dataUrl: `data:image/jpeg;base64,${frame.data}` });
        }
        cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      });
      return cdpSession;
    } catch (error: any) {
      this.logger.warn(`Failed to start live-view screencast: ${error.message}`);
      return null;
    }
  }

  private async stopScreencast(cdpSession: CDPSession | null): Promise<void> {
    if (!cdpSession) return;
    await cdpSession.send('Page.stopScreencast').catch(() => {});
    await cdpSession.detach().catch(() => {});
  }

  // JPEG at moderate quality rather than PNG — a full-page screenshot is
  // only ever looked at to confirm what happened (a success message, a
  // CAPTCHA, a validation error), not inspected pixel-by-pixel, and this
  // keeps each one well under 200KB in Postgres.
  // `timeoutMs` lets the orchestrator-level timeout handler above take one
  // last screenshot of a possibly-hung page without risking hanging on the
  // screenshot call itself -- normal (non-timeout) call sites keep the
  // previous unbounded behavior.
  private async captureScreenshot(page: Page, applicationId: string, timeoutMs?: number): Promise<void> {
    try {
      const screenshotPromise = page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      const screenshot = timeoutMs
        ? await Promise.race([
            screenshotPromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
          ])
        : await screenshotPromise;
      if (!screenshot) return;
      await this.prisma.application.update({
        where: { id: applicationId },
        data: { screenshot, screenshotTakenAt: new Date() },
      });
    } catch (error: any) {
      this.logger.warn(`Failed to capture screenshot for ${applicationId}: ${error.message}`);
    }
  }

  private async captureUnknownFields(page: Page, platformKey: string, sourceUrl: string, userId: string): Promise<void> {
    try {
      // Only scan if an actual apply modal or form is open, avoiding heavy scanning of full feed pages
      const formContainer = page.locator('.jobs-easy-apply-modal, [role="dialog"], form').first();
      const hasForm = await formContainer.isVisible().catch(() => false);
      if (!hasForm) return;

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
