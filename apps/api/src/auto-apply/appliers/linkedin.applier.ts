import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl } from './ats-common';

// Best-effort automation of LinkedIn\'s own UI — LinkedIn does not offer an
// "apply on my behalf" API. Logging in is NOT automated: LinkedIn actively
// hardens its login form against automation, so this only ever reuses a
// session established manually via `npm run establish-session -- linkedin`.
@Injectable()
export class LinkedInApplier implements JobApplier {
  readonly credentialPlatform = 'linkedin';
  private readonly logger = new Logger(LinkedInApplier.name);

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const loginResult = await this.ensureLoggedIn(page);
    if (loginResult) return loginResult;

    // Login may have redirected away from the job posting — go back to it.
    if (!page.url().includes('/jobs/view/')) {
      await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    await page.waitForTimeout(1500);

    // Matches both French ("Candidature simplifiée") and English ("Easy Apply")
    const easyApplyButton = page
      .getByRole('button', { name: /candidature simplifiée|easy apply|postulation simplifiée/i })
      .or(page.locator('.jobs-apply-button, button[data-job-id]:has-text("simplifiée"), button:has-text("Candidature simplifiée"), button:has-text("Easy Apply")'))
      .first();

    const hasEasyApply = await easyApplyButton.isVisible().catch(() => false);
    if (!hasEasyApply) {
      // External apply button
      const externalApplyButton = page
        .getByRole('link', { name: /postuler|apply/i })
        .or(page.getByRole('button', { name: /postuler|apply/i }))
        .or(page.locator('a[href*="/safety/go/"]'))
        .first();

      if (!(await externalApplyButton.isVisible().catch(() => false))) {
        return {
          success: false,
          note: "Aucun bouton de candidature trouvé sur cette offre LinkedIn — à traiter manuellement.",
        };
      }

      const externalUrl = await resolveExternalApplyUrl(page, externalApplyButton, /linkedin\.com/i);
      if (!externalUrl) {
        return {
          success: false,
          note: "Cette offre LinkedIn ne propose pas de candidature automatisable — à traiter manuellement.",
        };
      }

      return { success: false, redirectToExternalUrl: externalUrl };
    }

    this.logger.log(`Found Easy Apply button for ${ctx.application.id}, clicking...`);
    await easyApplyButton.click();
    await page.waitForTimeout(2000);

    // Step through the multi-page Easy Apply modal
    for (let step = 0; step < 8; step++) {
      // Always upload CV if file input is present on this step
      const fileInput = page.locator('input[type="file"]').first();
      if ((await fileInput.count().catch(() => 0)) > 0) {
        await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
        await page.waitForTimeout(800);
      }

      // Fill cover letter if field exists on this step
      if (ctx.coverLetter) {
        const coverLetterField = page
          .locator('textarea[id*="cover" i], textarea[aria-label*="lettre" i], textarea[aria-label*="cover" i]')
          .first();
        if (await coverLetterField.isVisible().catch(() => false)) {
          await coverLetterField.fill(ctx.coverLetter).catch(() => {});
        }
      }

      await fillKnownFields(page, ctx.knownAnswers);

      // Submit button detection (Submit application / Envoyer la candidature)
      const submitButton = page
        .getByRole('button', { name: /submit application|envoyer la candidature|déposer la candidature|soumettre/i })
        .or(page.locator('button:has-text("Envoyer la candidature"), button:has-text("Submit application")'))
        .first();

      if (await submitButton.isVisible().catch(() => false)) {
        this.logger.log(`Submitting application for ${ctx.application.id}...`);
        await submitButton.click();
        await page.waitForTimeout(2500);

        const confirmed = await page
          .getByText(/application sent|candidature envoyée|votre candidature a été envoyée/i)
          .first()
          .isVisible()
          .catch(() => false);

        return confirmed
          ? { success: true }
          : { success: true, note: "Candidature Easy Apply soumise." };
      }

      // Next button (Suivant / Next / Review / Vérifier / Continuer / Examiner)
      const nextButton = page
        .getByRole('button', { name: /next|suivant|review|vérifier|continuer|examiner/i })
        .or(page.locator('button:has-text("Suivant"), button:has-text("Next"), button:has-text("Vérifier"), button:has-text("Examiner")'))
        .first();

      if (await nextButton.isVisible().catch(() => false)) {
        await nextButton.click();
        await page.waitForTimeout(1500);

        // Check if required fields prevented moving forward
        const errorVisible = await page
          .locator('.artdeco-inline-feedback--error:visible, [role="alert"]:has-text("requis"), [role="alert"]:has-text("obligatoire")')
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
        continue;
      }

      break;
    }

    return {
      success: false,
      note: "Formulaire Easy Apply non reconnu (étape inattendue) — à finaliser manuellement.",
    };
  }

  private async ensureLoggedIn(page: Page): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.linkedin.isLoginWallVisible(page);
    if (!onLoginWall) return null;

    return {
      success: false,
      sessionExpired: true,
      note: "Session LinkedIn absente ou expirée — connectez votre compte pour la rétablir.",
    };
  }
}
