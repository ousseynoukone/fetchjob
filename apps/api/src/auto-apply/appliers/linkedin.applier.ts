import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';

const LOGIN_URL = 'https://www.linkedin.com/login';
const SECURITY_CHECK_MARKERS = /checkpoint|challenge|two-step|verification|puzzle|captcha/i;

// Best-effort automation of LinkedIn's own UI — LinkedIn does not offer an
// "apply on my behalf" API, and its DOM/selectors change over time, so this
// is written defensively: at every step where the expected element isn't
// found, or a security checkpoint appears, it stops and returns
// `needs_review` rather than guessing further. Verify against the real site
// with AUTO_APPLY_HEADLESS=false before relying on it for real submissions.
@Injectable()
export class LinkedInApplier implements JobApplier {
  readonly credentialPlatform = 'linkedin';
  private readonly logger = new Logger(LinkedInApplier.name);

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const loginResult = await this.ensureLoggedIn(page, ctx);
    if (loginResult) return loginResult;

    // Login may have redirected away from the job posting — go back to it.
    if (!page.url().includes('/jobs/view/')) {
      await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    const easyApplyButton = page.getByRole('button', { name: /easy apply|postulation simplifiée/i }).first();
    const hasEasyApply = await easyApplyButton.isVisible().catch(() => false);
    if (!hasEasyApply) {
      return {
        success: false,
        note: "Pas de bouton Easy Apply sur cette offre (candidature externe) — à traiter manuellement.",
      };
    }

    await easyApplyButton.click();
    await page.waitForTimeout(1500);

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.isVisible().catch(() => false)) {
      await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
    }

    if (ctx.coverLetter) {
      const coverLetterField = page
        .locator('textarea[id*="cover" i], textarea[aria-label*="lettre" i], textarea[aria-label*="cover" i]')
        .first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await coverLetterField.fill(ctx.coverLetter).catch(() => {});
      }
    }

    // Step through the multi-page Easy Apply modal. Bounded to 6 steps —
    // a real flow rarely has more, and this guards against an infinite loop
    // if a "Next" button keeps re-appearing without progressing.
    for (let step = 0; step < 6; step++) {
      await fillKnownFields(page, ctx.knownAnswers);

      const errorVisible = await page
        .locator('[role="alert"], .artdeco-inline-feedback--error')
        .first()
        .isVisible()
        .catch(() => false);
      if (errorVisible) {
        const unknownFields = await scanInvalidFields(page);
        if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);
        return {
          success: false,
          note: 'Le formulaire Easy Apply contient une question personnalisée non renseignée — à finaliser manuellement.',
        };
      }

      const submitButton = page.getByRole('button', { name: /submit application|envoyer la candidature/i }).first();
      if (await submitButton.isVisible().catch(() => false)) {
        await submitButton.click();
        await page.waitForTimeout(2000);

        const confirmed = await page
          .getByText(/application sent|candidature envoyée|votre candidature a été envoyée/i)
          .first()
          .isVisible()
          .catch(() => false);

        return confirmed
          ? { success: true }
          : { success: false, note: "Soumission Easy Apply envoyée mais confirmation non détectée — à vérifier manuellement." };
      }

      const nextButton = page.getByRole('button', { name: /next|suivant|review|vérifier/i }).first();
      if (await nextButton.isVisible().catch(() => false)) {
        await nextButton.click();
        await page.waitForTimeout(1200);
        continue;
      }

      break;
    }

    return {
      success: false,
      note: "Formulaire Easy Apply non reconnu (étape inattendue) — à finaliser manuellement.",
    };
  }

  private async ensureLoggedIn(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    const onLoginWall =
      page.url().includes('/login') ||
      page.url().includes('/uas/login') ||
      (await page.locator('#username').isVisible().catch(() => false));

    if (!onLoginWall) return null; // already have a valid session

    if (!ctx.credential) {
      return { success: false, note: 'Session LinkedIn expirée et aucun identifiant enregistré.' };
    }

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#username').fill(ctx.credential.email);
    await page.locator('#password').fill(ctx.credential.password);
    await page.getByRole('button', { name: /sign in|se connecter/i }).click();
    await page.waitForTimeout(2500);

    if (SECURITY_CHECK_MARKERS.test(page.url())) {
      return {
        success: false,
        note: 'LinkedIn demande une vérification de sécurité (2FA/CAPTCHA) — connectez-vous manuellement une fois pour établir une session réutilisable.',
      };
    }

    return null;
  }
}
