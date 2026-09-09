import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { dismissCookieBanner, SESSION_CHECKS } from './ats-common';

// Same best-effort/defensive posture as the other account-based appliers.
// Login is NOT automated — HelloWork runs a real bot-detection check
// (FriendlyCaptcha) that failed outright against a headless browser in
// live testing ("Échec de la vérification — Browser check failed"), so
// this only ever reuses a session established manually via
// `npm run establish-session -- hellowork ...`.
@Injectable()
export class HelloWorkApplier implements JobApplier {
  readonly credentialPlatform = 'hellowork';
  private readonly logger = new Logger(HelloWorkApplier.name);

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
        note: "Bouton de candidature HelloWork introuvable sur cette offre — à traiter manuellement.",
      };
    }

    await applyButton.click();
    await page.waitForTimeout(1500);

    const externalRedirectNotice = await page
      .getByText(/site de l'employeur|candidature externe|vous allez être redirigé/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (externalRedirectNotice) {
      return {
        success: false,
        note: "Cette offre HelloWork redirige vers un site externe — à traiter manuellement.",
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
          note: 'Le formulaire de candidature HelloWork contient un champ non renseigné — à finaliser manuellement.',
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
          : { success: false, note: "Soumission HelloWork envoyée mais confirmation non détectée — à vérifier manuellement." };
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
      note: "Formulaire de candidature HelloWork non reconnu (étape inattendue) — à finaliser manuellement.",
    };
  }

  private async ensureLoggedIn(page: Page): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.hellowork.isLoginWallVisible(page);
    if (!onLoginWall) return null; // already have a valid, reused session

    return {
      success: false,
      sessionExpired: true,
      note: "Session HelloWork absente ou expirée — exécutez `npm run establish-session -- hellowork votre@email.com` sur votre machine pour la rétablir.",
    };
  }
}
