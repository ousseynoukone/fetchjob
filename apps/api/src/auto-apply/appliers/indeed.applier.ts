import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl, fillIdentityFields, uploadCv } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

// Same best-effort/defensive posture as the LinkedIn applier: Indeed's
// "Indeed Apply" flow sometimes runs inline, sometimes in a popup on
// smartapply.indeed.com — this handles both, and bails out to
// `needs_review` at the first unrecognized step rather than guessing.
// Login is NOT automated — Indeed only offers Google sign-in in practice,
// which isn't something to script — only a session established manually
// via `npm run establish-session -- indeed ...` is ever reused.
// Verify against the real site with AUTO_APPLY_HEADLESS=false first.
@Injectable()
export class IndeedApplier implements JobApplier {
  readonly credentialPlatform = 'indeed';
  private readonly logger = new Logger(IndeedApplier.name);

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    const loginResult = await this.ensureLoggedIn(page);
    if (loginResult) return loginResult;

    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const applyButton = page.getByRole('button', { name: /apply now|postuler maintenant|postuler dès maintenant/i }).first();
    const hasApplyButton = await applyButton.isVisible().catch(() => false);
    if (!hasApplyButton) {
      // No inline "Indeed Apply" button — some postings only offer a link
      // straight to the employer's own site instead. Follow it rather than
      // giving up, so ATS-by-URL routing (or the generic fallback) gets a
      // real shot at the real form.
      const externalApplyButton = page
        .getByRole('link', { name: /apply now|apply on company site|postuler sur le site/i })
        .first();

      if (!(await externalApplyButton.isVisible().catch(() => false))) {
        return {
          success: false,
          note: "Aucun bouton de candidature trouvé sur cette offre Indeed — à traiter manuellement.",
        };
      }

      const externalUrl = await resolveExternalApplyUrl(page, externalApplyButton, /indeed\.com/i);
      if (!externalUrl) {
        return {
          success: false,
          note: "Cette offre Indeed ne propose pas de candidature automatisable — à traiter manuellement.",
        };
      }

      return { success: false, redirectToExternalUrl: externalUrl };
    }

    const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    await applyButton.click();
    const popup = await popupPromise;
    const target = popup || page;
    await target.waitForTimeout(1500);
    if (popup) await dismissCookieBanner(popup);

    await fillIdentityFields(target, ctx.cv);

    // `count()`, not `isVisible()` — confirmed live that Playwright's
    // setInputFiles works on a hidden input; gating on visibility silently
    // skipped the upload whenever Indeed hides the real input behind a
    // styled button, same issue found and fixed across every applier here.
    const fileInput = target.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await uploadCv(fileInput, ctx).catch(() => {});
    }

    if (ctx.coverLetter) {
      // Confirmed live via a real smartapply.indeed.com click-through:
      // widened to match "motivation"/"message" wording too, the same
      // French phrasings every other applier here already accounts for --
      // this one only ever looked for "cover" or "lettre".
      const coverLetterField = target
        .locator(
          'textarea[id*="cover" i], textarea[aria-label*="lettre" i], textarea[aria-label*="cover" i], textarea[aria-label*="motivation" i], textarea[id*="motivation" i], textarea[name*="message" i]',
        )
        .first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await coverLetterField.fill(ctx.coverLetter).catch(() => {});
      }
    }

    return runFormLoop(target, ctx, this.ai, {
      // Confirmed live: Indeed's real submit button on smartapply.indeed.com
      // reads "Déposer ma candidature" -- matched neither "envoyer ma
      // candidature" nor a bare "postuler" ending, so a fully-completed
      // form would never hit the free fast-path submit and always fell
      // through to the costed AI fallback for that one click.
      submitText: /submit( your)? application|envoyer( ma)? candidature|postuler$|déposer( ma candidature)?/i,
      nextText: /continue|continuer|next|suivant/i,
      // Confirmed live: the real confirmation heading reads "Votre
      // candidature a été envoyée à <employeur>" -- no "bien" -- which the
      // previous pattern required, so a genuinely successful Indeed
      // submission was reported as "confirmation non détectée" every time.
      successText: /application submitted|candidature envoyée|votre candidature a (bien )?été envoyée/i,
      blockedNote: 'Le formulaire de candidature Indeed contient une question non renseignée — à finaliser manuellement.',
      unresolvedNote: 'Soumission Indeed envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }

  private async ensureLoggedIn(page: Page): Promise<ApplyResult | null> {
    // Checking for a login *form* against the job posting itself would be
    // meaningless — Indeed postings render identically whether the visitor
    // is authenticated or not, so this would never actually catch an
    // expired session (same structural gap confirmed live on HelloWork:
    // an invalid session sailed straight through to its own anonymous
    // guest-apply flow instead of ever being flagged). Visiting the real
    // account page first is the same page SessionHealthService's own
    // proactive check already uses, and is the only way this check can
    // mean anything.
    await page.goto(SESSION_CHECKS.indeed.homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await dismissCookieBanner(page);

    const onLoginWall = await SESSION_CHECKS.indeed.isLoginWallVisible(page);
    if (!onLoginWall) return null; // already have a valid, reused session

    return {
      success: false,
      sessionExpired: true,
      note: "Session Indeed absente ou expirée — exécutez `npm run establish-session -- indeed votre@email.com` sur votre machine pour la rétablir.",
    };
  }
}
