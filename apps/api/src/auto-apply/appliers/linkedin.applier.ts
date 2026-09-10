import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl } from './ats-common';

// Best-effort automation of LinkedIn's own UI -- LinkedIn does not offer an
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

    // Login may have redirected away from the job posting -- go back to it.
    if (!page.url().includes('/jobs/view/')) {
      await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    await page.waitForTimeout(1500);

    // Matches both French ("Candidature simplifiée") and English ("Easy Apply")
    const easyApplyButton = page
      .getByRole('button', { name: /candidature simplifi[e\u00e9]e|easy apply|postulation simplifi[e\u00e9]e/i })
      .or(page.locator('.jobs-apply-button, button[data-job-id]:has-text("simplifi"), button:has-text("Candidature simplifi"), button:has-text("Easy Apply")'))
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
          note: 'Aucun bouton de candidature trouv\u00e9 sur cette offre LinkedIn -- \u00e0 traiter manuellement.',
        };
      }

      const externalUrl = await resolveExternalApplyUrl(page, externalApplyButton, /linkedin\.com/i);
      if (!externalUrl) {
        return {
          success: false,
          note: 'Cette offre LinkedIn ne propose pas de candidature automatisable -- \u00e0 traiter manuellement.',
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

      // Fill CV identity fields explicitly (phone, city/location) -- these
      // are excluded from fillKnownFields by design (to prevent learned
      // "custom question" answers from landing in the wrong field), so we
      // handle them here with targeted selectors before the generic pass.
      await this.fillCvIdentityFields(page, ctx);

      await fillKnownFields(page, ctx.knownAnswers);

      // Submit button detection (Submit application / Envoyer la candidature)
      const submitButton = page
        .getByRole('button', { name: /submit application|envoyer la candidature|d[e\u00e9]poser la candidature|soumettre/i })
        .or(page.locator('button:has-text("Envoyer la candidature"), button:has-text("Submit application")'))
        .first();

      if (await submitButton.isVisible().catch(() => false)) {
        this.logger.log(`Submitting application for ${ctx.application.id}...`);
        await submitButton.click();
        await page.waitForTimeout(2500);

        const confirmed = await page
          .getByText(/application sent|candidature envoy[e\u00e9]e|votre candidature a [e\u00e9]t[e\u00e9] envoy[e\u00e9]e/i)
          .first()
          .isVisible()
          .catch(() => false);

        return confirmed
          ? { success: true }
          : { success: true, note: 'Candidature Easy Apply soumise.' };
      }

      // Next button (Suivant / Next / Review / V\u00e9rifier / Continuer / Examiner)
      const nextButton = page
        .getByRole('button', { name: /next|suivant|review|v[e\u00e9]rifier|continuer|examiner/i })
        .or(page.locator('button:has-text("Suivant"), button:has-text("Next"), button:has-text("V\u00e9rifier"), button:has-text("Examiner")'))
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
          // Try once more to fill CV identity fields after the error appears --
          // LinkedIn sometimes re-renders the phone field after a failed Next click.
          await this.fillCvIdentityFields(page, ctx);
          await fillKnownFields(page, ctx.knownAnswers);

          // Re-attempt clicking Next after the retry fill
          const retryNext = page
            .getByRole('button', { name: /next|suivant|review|v[e\u00e9]rifier|continuer|examiner/i })
            .first();
          if (await retryNext.isVisible().catch(() => false)) {
            await retryNext.click();
            await page.waitForTimeout(1500);

            // If errors still present after retry, give up and report them
            const stillError = await page
              .locator('.artdeco-inline-feedback--error:visible, [role="alert"]:has-text("requis"), [role="alert"]:has-text("obligatoire")')
              .first()
              .isVisible()
              .catch(() => false);

            if (!stillError) continue; // error resolved, proceed to next step
          }

          const unknownFields = await scanInvalidFields(page);
          if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);
          return {
            success: false,
            note: 'Le formulaire Easy Apply contient une question personnalis\u00e9e non renseign\u00e9e -- \u00e0 finaliser manuellement.',
          };
        }
        continue;
      }

      break;
    }

    return {
      success: false,
      note: 'Formulaire Easy Apply non reconnu (\u00e9tape inattendue) -- \u00e0 finaliser manuellement.',
    };
  }

  // Fills identity fields (phone, city) from the CV directly, using multiple
  // selector strategies to match LinkedIn's various field implementations.
  // These are intentionally excluded from fillKnownFields to prevent answers
  // learned for "custom" questions from accidentally landing in identity
  // fields -- so they need their own explicit handling here.
  private async fillCvIdentityFields(page: Page, ctx: ApplyContext): Promise<void> {
    const { phone, location } = ctx.cv;

    if (phone) {
      // LinkedIn phone fields use various attributes -- try each in order.
      // Prefer type="tel" first since that is the most reliable signal.
      const phoneSelectors = [
        'input[type="tel"]',
        'input[id*="phone" i]',
        'input[name*="phone" i]',
        'input[aria-label*="phone" i]',
        'input[aria-label*="tel" i]',
        'input[placeholder*="phone" i]',
        'input[placeholder*="tel" i]',
      ];

      for (const sel of phoneSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) {
          const currentValue = await el.inputValue().catch(() => '');
          if (!currentValue) {
            await el.fill(phone).catch(() => {});
            this.logger.debug(`Filled phone field (selector: ${sel})`);
          }
          break;
        }
      }
    }

    // Fill city/location field if LinkedIn asks for it separately
    if (location) {
      const locationSelectors = [
        'input[id*="city" i]',
        'input[id*="location" i]',
        'input[name*="city" i]',
        'input[aria-label*="city" i]',
        'input[aria-label*="ville" i]',
        'input[aria-label*="location" i]',
      ];

      for (const sel of locationSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) {
          const currentValue = await el.inputValue().catch(() => '');
          if (!currentValue) {
            await el.fill(location).catch(() => {});
            await page.waitForTimeout(400);
            // Dismiss any autocomplete dropdown that appeared
            const option = page.locator('[role="option"]').first();
            if (await option.isVisible().catch(() => false)) {
              await option.click().catch(() => {});
            } else {
              await el.press('Escape').catch(() => {});
            }
          }
          break;
        }
      }
    }
  }

  private async ensureLoggedIn(page: Page): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.linkedin.isLoginWallVisible(page);
    if (!onLoginWall) return null;

    return {
      success: false,
      sessionExpired: true,
      note: 'Session LinkedIn absente ou expir\u00e9e -- connectez votre compte pour la r\u00e9tablir.',
    };
  }
}
