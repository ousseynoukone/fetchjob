import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';

// Same best-effort/defensive posture as the other account-based appliers
// (LinkedIn, Indeed, France Travail): HelloWork's own "Postuler" flow,
// driven generically and abandoned in favor of `needs_review` at the first
// unrecognized step. Verify against the real site with
// AUTO_APPLY_HEADLESS=false before relying on it for real submissions.
@Injectable()
export class HelloWorkApplier implements JobApplier {
  readonly credentialPlatform = 'hellowork';
  private readonly logger = new Logger(HelloWorkApplier.name);

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const loginResult = await this.ensureLoggedIn(page, ctx);
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

  private async ensureLoggedIn(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    const emailField = page.locator('input[type="email"], #email').first();
    const onLoginWall = await emailField.isVisible().catch(() => false);
    if (!onLoginWall) return null;

    if (!ctx.credential) {
      return { success: false, note: 'Session HelloWork expirée et aucun identifiant enregistré.' };
    }

    await emailField.fill(ctx.credential.email);
    const passwordField = page.locator('input[type="password"], #password').first();
    await passwordField.fill(ctx.credential.password);
    await page.getByRole('button', { name: /se connecter|connexion/i }).first().click();
    await page.waitForTimeout(2000);

    if (/captcha|challenge|verification/i.test(page.url())) {
      return {
        success: false,
        note: 'HelloWork demande une vérification de sécurité — connectez-vous manuellement une fois pour établir une session réutilisable.',
      };
    }

    return null;
  }
}
