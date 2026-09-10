import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl } from './ats-common';

function formatFrenchPhone(raw: string): string {
  if (!raw) return '';
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+33')) {
    const rest = cleaned.slice(3);
    return rest.startsWith('0') ? rest : '0' + rest;
  }
  if (cleaned.startsWith('0033')) {
    const rest = cleaned.slice(4);
    return rest.startsWith('0') ? rest : '0' + rest;
  }
  return cleaned;
}

@Injectable()
export class LinkedInApplier implements JobApplier {
  readonly credentialPlatform = 'linkedin';
  private readonly logger = new Logger(LinkedInApplier.name);

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await ctx.appendLog?.(`Navigation vers l'offre LinkedIn : ${ctx.application.jobTitle}...`);
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const loginResult = await this.ensureLoggedIn(page, ctx);
    if (loginResult) return loginResult;

    if (!page.url().includes('/jobs/view/')) {
      await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    await page.waitForTimeout(1500);

    const easyApplyButton = page
      .getByRole('button', { name: /candidature simplifi[e\u00e9]e|easy apply|postulation simplifi[e\u00e9]e/i })
      .or(page.locator('.jobs-apply-button, button[data-job-id]:has-text("simplifi"), button:has-text("Candidature simplifi"), button:has-text("Easy Apply")'))
      .first();

    const hasEasyApply = await easyApplyButton.isVisible().catch(() => false);
    if (!hasEasyApply) {
      const externalApplyButton = page
        .getByRole('link', { name: /postuler|apply/i })
        .or(page.getByRole('button', { name: /postuler|apply/i }))
        .or(page.locator('a[href*="/safety/go/"]'))
        .first();

      if (!(await externalApplyButton.isVisible().catch(() => false))) {
        await ctx.appendLog?.('Aucun bouton de candidature trouvé sur cette offre LinkedIn.');
        return {
          success: false,
          note: 'Aucun bouton de candidature trouvé sur cette offre LinkedIn -- à traiter manuellement.',
        };
      }

      await ctx.appendLog?.('Redirection vers le site employeur...');
      const externalUrl = await resolveExternalApplyUrl(page, externalApplyButton, /linkedin\.com/i);
      if (!externalUrl) {
        return {
          success: false,
          note: 'Cette offre LinkedIn ne propose pas de candidature automatisable -- à traiter manuellement.',
        };
      }

      return { success: false, redirectToExternalUrl: externalUrl };
    }

    this.logger.log(`Found Easy Apply button for ${ctx.application.id}, clicking...`);
    await ctx.appendLog?.('Bouton Candidature simplifiée détecté, ouverture du modal...');
    await easyApplyButton.click();

    // Active wait for modal form content to load
    // LinkedIn renders an animated spinner while fetching the questions API.
    await ctx.appendLog?.('Chargement du formulaire Easy Apply...');
    const MODAL_LOAD_TIMEOUT = 20_000;
    const modalContentSelector = [
      'input[type="tel"]',
      'input[type="text"]',
      'input[type="file"]',
      'button:has-text("Importer le CV")',
      'button:has-text("Upload resume")',
      'textarea',
      'select',
      'button[aria-label*="Submit" i]',
      'button[aria-label*="Next" i]',
      'button[aria-label*="Suivant" i]',
      'button:has-text("Suivant")',
      'button:has-text("Next")',
      'button:has-text("Vérifier")',
      'button:has-text("Review")',
      'button:has-text("Envoyer")',
    ].join(', ');

    const modalLoaded = await page
      .locator(modalContentSelector)
      .first()
      .waitFor({ state: 'visible', timeout: MODAL_LOAD_TIMEOUT })
      .then(() => true)
      .catch(() => false);

    if (!modalLoaded) {
      await ctx.appendLog?.('Le formulaire LinkedIn ne s\'est pas chargé (délai dépassé).');
      return {
        success: false,
        note: 'Le formulaire Easy Apply LinkedIn ne s\'est pas chargé (spinner perpétuel après 20s) -- la session est peut-être expirée ou soumise à un contrôle anti-bot. À finaliser manuellement.',
      };
    }

    await page.waitForTimeout(800);

    // Step through the multi-page Easy Apply modal
    for (let step = 0; step < 8; step++) {
      const stepHeader = await page
        .locator('[role="dialog"] h3, [role="dialog"] h2, .artdeco-modal__header')
        .first()
        .innerText()
        .catch(() => '');
      await ctx.appendLog?.(`Étape ${step + 1} du formulaire LinkedIn ${stepHeader ? `(${stepHeader})` : ''}...`);

      // 1. CV Upload handling (both native file input AND Importer le CV button)
      const uploadBtn = page
        .getByRole('button', { name: /importer le cv|upload resume/i })
        .or(page.locator('button:has-text("Importer le CV"), button:has-text("Upload resume")'))
        .first();

      const fileInput = page.locator('input[type="file"]').first();

      if (await uploadBtn.isVisible().catch(() => false)) {
        await ctx.appendLog?.('Téléversement du CV...');
        try {
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 8000 }),
            uploadBtn.click(),
          ]);
          await fileChooser.setFiles(ctx.cvPdfPath);
          await page.waitForTimeout(2500);
          await ctx.appendLog?.('CV téléversé.');
        } catch (e: any) {
          this.logger.warn(`FileChooser error: ${e.message}`);
        }
      } else if ((await fileInput.count().catch(() => 0)) > 0) {
        await ctx.appendLog?.('Téléversement du CV...');
        await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
        await page.waitForTimeout(1000);
        await ctx.appendLog?.('CV téléversé.');
      }

      // 2. Fill cover letter if field exists on this step
      if (ctx.coverLetter) {
        const coverLetterField = page
          .locator('textarea[id*="cover" i], textarea[aria-label*="lettre" i], textarea[aria-label*="cover" i]')
          .first();
        if (await coverLetterField.isVisible().catch(() => false)) {
          await coverLetterField.fill(ctx.coverLetter).catch(() => {});
        }
      }

      // 3. Fill CV identity fields (phone, city/location)
      await this.fillCvIdentityFields(page, ctx);

      // 4. Fill custom questions from learned answers
      await fillKnownFields(page, ctx.knownAnswers);

      // 5. Submit button detection
      const submitButton = page
        .getByRole('button', { name: /submit application|envoyer la candidature|d[e\u00e9]poser la candidature|soumettre/i })
        .or(page.locator('button:has-text("Envoyer la candidature"), button:has-text("Submit application")'))
        .first();

      if (await submitButton.isVisible().catch(() => false)) {
        this.logger.log(`Submitting application for ${ctx.application.id}...`);
        await ctx.appendLog?.('Vérification finale et soumission de la candidature...');
        await submitButton.click();
        await page.waitForTimeout(3000);

        const confirmed = await page
          .getByText(/application sent|candidature envoy[e\u00e9]e|votre candidature a [e\u00e9]t[e\u00e9] envoy[e\u00e9]e/i)
          .first()
          .isVisible()
          .catch(() => false);

        await ctx.appendLog?.('Candidature Easy Apply soumise avec succès !');
        return confirmed
          ? { success: true }
          : { success: true, note: 'Candidature Easy Apply soumise.' };
      }

      // 6. Next / Review button
      const nextButton = page
        .getByRole('button', { name: /next|suivant|review|v[e\u00e9]rifier|continuer|examiner/i })
        .or(page.locator('button:has-text("Suivant"), button:has-text("Next"), button:has-text("Vérifier"), button:has-text("Review"), button:has-text("Examiner")'))
        .first();

      if (await nextButton.isVisible().catch(() => false)) {
        await nextButton.click();
        await page.waitForTimeout(2000);

        // Check if required fields prevented moving forward
        const errorCount = await page.locator(
          '.artdeco-inline-feedback--error:visible, [role="alert"]:visible, [data-testid="text-input-helper-text"]:has-text("non valide"), p:has-text("Ce champ est obligatoire"), p:has-text("Saisie non valide")'
        ).count().catch(() => 0);

        if (errorCount > 0) {
          // Retry filling phone & known fields
          await this.fillCvIdentityFields(page, ctx);
          await fillKnownFields(page, ctx.knownAnswers);

          const retryNext = page
            .getByRole('button', { name: /next|suivant|review|v[e\u00e9]rifier|continuer|examiner/i })
            .or(page.locator('button:has-text("Suivant"), button:has-text("Next"), button:has-text("Vérifier"), button:has-text("Review")'))
            .first();

          if (await retryNext.isVisible().catch(() => false)) {
            await retryNext.click();
            await page.waitForTimeout(2000);
          }

          const stillErrors = await page.locator(
            '.artdeco-inline-feedback--error:visible, [role="alert"]:visible, [data-testid="text-input-helper-text"]:has-text("non valide"), p:has-text("Ce champ est obligatoire"), p:has-text("Saisie non valide")'
          ).count().catch(() => 0);

          if (stillErrors > 0) {
            const unknownFields = await scanInvalidFields(page);
            if (unknownFields.length) {
              await ctx.reportUnknownFields(unknownFields);
              const fieldNames = unknownFields.map((f) => f.questionText).join(', ');
              await ctx.appendLog?.(`Questions supplémentaires à renseigner : ${fieldNames}`);
              return {
                success: false,
                note: `Questions supplémentaires requises sur LinkedIn : ${fieldNames}`,
              };
            }
            return {
              success: false,
              note: 'Le formulaire Easy Apply contient des questions personnalisées non renseignées -- à finaliser manuellement.',
            };
          }
        }
        continue;
      }

      break;
    }

    return {
      success: false,
      note: 'Formulaire Easy Apply non reconnu (étape inattendue) -- à finaliser manuellement.',
    };
  }

  private async fillCvIdentityFields(page: Page, ctx: ApplyContext): Promise<void> {
    const { phone, location } = ctx.cv;

    if (phone) {
      const cleanPhone = formatFrenchPhone(phone);
      const phoneSelectors = [
        'input[type="tel"]',
        'input[aria-label*="téléphone" i]',
        'input[aria-label*="phone" i]',
        'input[id*="phone" i]',
        'input[name*="phone" i]',
        'input[placeholder*="téléphone" i]',
        'input[placeholder*="phone" i]',
      ];

      for (const sel of phoneSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) {
          const currentValue = await el.inputValue().catch(() => '');
          if (!currentValue || currentValue !== cleanPhone) {
            await el.fill(cleanPhone).catch(() => {});
            await el.dispatchEvent('input').catch(() => {});
            await el.dispatchEvent('change').catch(() => {});
            this.logger.debug(`Filled phone field: ${cleanPhone} (selector: ${sel})`);
            await ctx.appendLog?.(`Numéro de téléphone renseigné : ${cleanPhone}`);
          }
          break;
        }
      }
    }

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

  private async ensureLoggedIn(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.linkedin.isLoginWallVisible(page);
    if (!onLoginWall) return null;

    await ctx.appendLog?.('Session LinkedIn absente ou expirée.');
    return {
      success: false,
      sessionExpired: true,
      note: 'Session LinkedIn absente ou expirée -- connectez votre compte pour la rétablir.',
    };
  }
}
