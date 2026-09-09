import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillIfVisible, dismissCookieBanner } from './ats-common';
import { fillKnownFields, scanInvalidFields } from './form-fields';

// Lever-hosted application forms (jobs.lever.co) are public, no account
// needed — same rationale as GreenhouseApplier for having no credential
// platform. Lever uses a single "Full Name" field rather than first/last.
@Injectable()
export class LeverApplier implements JobApplier {
  readonly credentialPlatform = null;

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const revealFormLink = page.getByRole('link', { name: /apply for this job/i }).first();
    if (await revealFormLink.isVisible().catch(() => false)) {
      await revealFormLink.click();
      await page.waitForTimeout(1000);
    }

    await fillIfVisible(page.locator('input[name="name"]').first(), ctx.cv.fullName);
    await fillIfVisible(page.locator('input[name="email"]').first(), ctx.cv.email);
    await fillIfVisible(page.locator('input[name="phone"]').first(), ctx.cv.phone);

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.isVisible().catch(() => false)) {
      await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
    } else {
      // Lever hides the file input behind an "Attach Resume/CV" button.
      const attachButton = page.getByText(/attach resume|attach cv/i).first();
      if (await attachButton.isVisible().catch(() => false)) {
        await attachButton.click().catch(() => {});
        await page.waitForTimeout(500);
        await page.locator('input[type="file"]').first().setInputFiles(ctx.cvPdfPath).catch(() => {});
      }
    }

    if (ctx.coverLetter) {
      const additionalInfoField = page.locator('textarea[name="comments"], textarea[name*="additional" i]').first();
      if (await additionalInfoField.isVisible().catch(() => false)) {
        await additionalInfoField.fill(ctx.coverLetter).catch(() => {});
      }
    }

    await fillKnownFields(page, ctx.knownAnswers);

    const submitButton = page.getByRole('button', { name: /submit application/i }).first();
    if (!(await submitButton.isVisible().catch(() => false))) {
      return {
        success: false,
        note: 'Formulaire Lever non reconnu (bouton de soumission introuvable) — à finaliser manuellement.',
      };
    }

    await submitButton.click();
    await page.waitForTimeout(2000);

    const stillHasErrors = await page
      .locator('[role="alert"], .error-message, [class*="error"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (stillHasErrors) {
      const unknownFields = await scanInvalidFields(page);
      if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);
      return {
        success: false,
        note: 'Le formulaire Lever contient des questions personnalisées non renseignées — à finaliser manuellement.',
      };
    }

    const confirmed = await page
      .getByText(/application submitted|thank you for applying|thanks for applying/i)
      .first()
      .isVisible()
      .catch(() => false);

    return confirmed
      ? { success: true }
      : { success: false, note: 'Soumission Lever envoyée mais confirmation non détectée — à vérifier manuellement.' };
  }
}
