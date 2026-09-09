import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { splitName, fillIfVisible, dismissCookieBanner } from './ats-common';
import { fillKnownFields, scanInvalidFields } from './form-fields';

// Greenhouse-hosted application forms (boards.greenhouse.io, job-boards.
// greenhouse.io) are public and need no account login — the form sits on
// the job posting page itself. No credential platform, since this isn't
// one account shared across offers: every company runs its own instance.
@Injectable()
export class GreenhouseApplier implements JobApplier {
  readonly credentialPlatform = null;

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const revealFormLink = page
      .getByRole('link', { name: /apply for this job|apply now/i })
      .or(page.getByRole('button', { name: /apply for this job|apply now/i }))
      .first();
    if (await revealFormLink.isVisible().catch(() => false)) {
      await revealFormLink.click();
      await page.waitForTimeout(1000);
    }

    const { first, last } = splitName(ctx.cv.fullName);
    await fillIfVisible(page.getByLabel(/first name/i).first(), first);
    await fillIfVisible(page.getByLabel(/last name/i).first(), last);
    await fillIfVisible(page.getByLabel(/^email/i).first(), ctx.cv.email);
    await fillIfVisible(page.getByLabel(/phone/i).first(), ctx.cv.phone);

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.isVisible().catch(() => false)) {
      await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
    }

    if (ctx.coverLetter) {
      const coverLetterField = page.locator('textarea[id*="cover" i], textarea[aria-label*="cover" i]').first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await coverLetterField.fill(ctx.coverLetter).catch(() => {});
      }
    }

    await fillKnownFields(page, ctx.knownAnswers);

    const submitButton = page.getByRole('button', { name: /submit application/i }).first();
    if (!(await submitButton.isVisible().catch(() => false))) {
      return {
        success: false,
        note: 'Formulaire Greenhouse non reconnu (bouton de soumission introuvable) — à finaliser manuellement.',
      };
    }

    await submitButton.click();
    await page.waitForTimeout(2000);

    // Greenhouse re-renders the form with per-field "This field is required"
    // messages on an invalid submit — usually unanswered custom questions
    // we have no safe way to fill.
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
        note: 'Le formulaire Greenhouse contient des questions personnalisées non renseignées — à finaliser manuellement.',
      };
    }

    const confirmed = await page
      .getByText(/application submitted|thank you for applying|thanks for applying/i)
      .first()
      .isVisible()
      .catch(() => false);

    return confirmed
      ? { success: true }
      : { success: false, note: 'Soumission Greenhouse envoyée mais confirmation non détectée — à vérifier manuellement.' };
  }
}
