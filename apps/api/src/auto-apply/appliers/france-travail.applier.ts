import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { dismissCookieBanner, SESSION_CHECKS } from './ats-common';

// France Travail aggregates postings from many partner sites — a large
// share of `sourceUrl`s point at the employer's own external site
// (`origineOffre.urlOrigine`, see ScrapingService), not at France Travail
// itself. This applier is only ever invoked for offers actually hosted on
// francetravail.fr (see AutoApplyService's matchesOwnDomain) — everything
// else routes straight to GenericApplier's best-effort form-filling instead.
@Injectable()
export class FranceTravailApplier implements JobApplier {
  readonly credentialPlatform = 'france_travail';
  private readonly logger = new Logger(FranceTravailApplier.name);

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const loginResult = await this.ensureLoggedIn(page);
    if (loginResult) return loginResult;

    const applyButton = page.getByRole('button', { name: /^postuler/i }).or(page.getByRole('link', { name: /^postuler/i })).first();
    const hasApplyButton = await applyButton.isVisible().catch(() => false);
    if (!hasApplyButton) {
      return {
        success: false,
        note: "Bouton de candidature France Travail introuvable sur cette offre — à traiter manuellement.",
      };
    }

    // On some offers "Postuler" is a dropdown toggle (aria-haspopup) rather
    // than a direct link — clicking it just reveals a menu with the real
    // action instead of navigating (confirmed live: id="detail-apply",
    // data-toggle="dropdown"). Click through to the actual item if so.
    const isDropdownToggle = (await applyButton.getAttribute('aria-haspopup').catch(() => null)) === 'true';
    await applyButton.click();
    await page.waitForTimeout(800);

    if (isDropdownToggle) {
      const menuItem = page
        .locator('.dropdown-menu:visible a, .dropdown-menu:visible button, [role="menu"]:visible a, [role="menu"]:visible button')
        .filter({ hasText: /postuler/i })
        .first();
      if (await menuItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await menuItem.click();
        await page.waitForTimeout(1200);
      }
    }

    const externalRedirectNotice = await page
      .getByText(/site de l'employeur|candidature externe|vous allez être redirigé/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (externalRedirectNotice) {
      return {
        success: false,
        note: "Cette offre France Travail redirige vers le site de l'employeur — à traiter manuellement.",
      };
    }

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.isVisible().catch(() => false)) {
      await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
    }

    if (ctx.coverLetter) {
      const coverLetterField = page
        .locator('textarea[id*="lettre" i], textarea[aria-label*="lettre" i], textarea[name*="message" i]')
        .first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await coverLetterField.fill(ctx.coverLetter).catch(() => {});
      }
    }

    for (let step = 0; step < 6; step++) {
      await fillKnownFields(page, ctx.knownAnswers);

      const errorVisible = await page
        .locator('[role="alert"], [class*="error"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (errorVisible) {
        const unknownFields = await scanInvalidFields(page);
        if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);
        return {
          success: false,
          note: 'Le formulaire de candidature France Travail contient un champ non renseigné — à finaliser manuellement.',
        };
      }

      const submitButton = page.getByRole('button', { name: /envoyer( ma)? candidature|valider ma candidature/i }).first();
      if (await submitButton.isVisible().catch(() => false)) {
        await submitButton.click();
        await page.waitForTimeout(2000);

        const confirmed = await page
          .getByText(/candidature envoyée|votre candidature a bien été (envoyée|transmise)/i)
          .first()
          .isVisible()
          .catch(() => false);

        return confirmed
          ? { success: true }
          : { success: false, note: "Soumission France Travail envoyée mais confirmation non détectée — à vérifier manuellement." };
      }

      const nextButton = page.getByRole('button', { name: /suivant|continuer/i }).first();
      if (await nextButton.isVisible().catch(() => false)) {
        await nextButton.click();
        await page.waitForTimeout(1200);
        continue;
      }

      break;
    }

    return {
      success: false,
      note: "Formulaire de candidature France Travail non reconnu (étape inattendue) — à finaliser manuellement.",
    };
  }

  private async ensureLoggedIn(page: Page): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.france_travail.isLoginWallVisible(page);
    if (!onLoginWall) return null; // already have a valid, reused session

    return {
      success: false,
      sessionExpired: true,
      note: "Session France Travail absente ou expirée — exécutez `npm run establish-session -- france_travail votre@email.com` sur votre machine pour la rétablir.",
    };
  }
}
