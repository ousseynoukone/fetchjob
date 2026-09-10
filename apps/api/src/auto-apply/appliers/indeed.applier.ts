import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl } from './ats-common';

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

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const loginResult = await this.ensureLoggedIn(page);
    if (loginResult) return loginResult;

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

    const fileInput = target.locator('input[type="file"]').first();
    if (await fileInput.isVisible().catch(() => false)) {
      await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
    }

    if (ctx.coverLetter) {
      const coverLetterField = target
        .locator('textarea[id*="cover" i], textarea[aria-label*="lettre" i], textarea[aria-label*="cover" i]')
        .first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await coverLetterField.fill(ctx.coverLetter).catch(() => {});
      }
    }

    for (let step = 0; step < 6; step++) {
      await fillKnownFields(target, ctx.knownAnswers);

      const errorVisible = await target
        .locator('[role="alert"], [class*="error"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (errorVisible) {
        const unknownFields = await scanInvalidFields(target);
        if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);
        return {
          success: false,
          note: 'Le formulaire de candidature Indeed contient une question non renseignée — à finaliser manuellement.',
        };
      }

      const submitButton = target
        .getByRole('button', { name: /submit( your)? application|envoyer( ma)? candidature|postuler$/i })
        .first();
      if (await submitButton.isVisible().catch(() => false)) {
        await submitButton.click();
        await target.waitForTimeout(2000);

        const confirmed = await target
          .getByText(/application submitted|candidature envoyée|votre candidature a bien été envoyée/i)
          .first()
          .isVisible()
          .catch(() => false);

        return confirmed
          ? { success: true }
          : { success: false, note: "Soumission Indeed envoyée mais confirmation non détectée — à vérifier manuellement." };
      }

      const continueButton = target.getByRole('button', { name: /continue|continuer|next|suivant/i }).first();
      if (await continueButton.isVisible().catch(() => false)) {
        await continueButton.click();
        await target.waitForTimeout(1200);
        continue;
      }

      break;
    }

    return {
      success: false,
      note: "Formulaire de candidature Indeed non reconnu (étape inattendue) — à finaliser manuellement.",
    };
  }

  private async ensureLoggedIn(page: Page): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.indeed.isLoginWallVisible(page);
    if (!onLoginWall) return null; // already have a valid, reused session

    return {
      success: false,
      sessionExpired: true,
      note: "Session Indeed absente ou expirée — exécutez `npm run establish-session -- indeed votre@email.com` sur votre machine pour la rétablir.",
    };
  }
}
