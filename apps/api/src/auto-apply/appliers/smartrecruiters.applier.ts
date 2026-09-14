import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { splitName, fillIfVisible, dismissCookieBanner } from './ats-common';
import { fillKnownFields, scanInvalidFields } from './form-fields';

// SmartRecruiters-hosted postings (jobs.smartrecruiters.com) are public, no
// account needed — same rationale as the other ATS appliers.
@Injectable()
export class SmartRecruitersApplier implements JobApplier {
  readonly credentialPlatform = null;

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    // Detect challenge/captcha early
    const isChallenge = await page.locator('text="Verification Required", text="Slide right to secure", [class*="captcha" i]').count().catch(() => 0);
    if (isChallenge > 0) {
      return {
        success: false,
        note: 'Vérification anti-robot (CAPTCHA) requise sur SmartRecruiters -- à finaliser manuellement.',
      };
    }

    const openFormButton = page
      .locator('a:has-text("Je suis intéressé"), button:has-text("Je suis intéressé"), a:has-text("Postuler"), button:has-text("Postuler"), a[href*="/apply"], button[data-test="st-apply-btn"]')
      .or(page.getByRole('button', { name: /i'm interested|apply now|apply|postuler|intéressé/i }))
      .or(page.getByRole('link', { name: /i'm interested|apply now|apply|postuler|intéressé/i }))
      .first();

    if (await openFormButton.isVisible().catch(() => false)) {
      await openFormButton.click();
      await page.waitForTimeout(2000);
    }

    const { first, last } = splitName(ctx.cv.fullName);
    await fillIfVisible(page.getByLabel(/first name/i).first(), first);
    await fillIfVisible(page.getByLabel(/last name/i).first(), last);
    await fillIfVisible(page.getByLabel(/^email/i).first(), ctx.cv.email);
    await fillIfVisible(page.getByLabel(/phone/i).first(), ctx.cv.phone);

    // `count()`, not `isVisible()` — confirmed live that Playwright's
    // setInputFiles works on a hidden input, same issue found and fixed
    // across every applier here.
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
    }

    await fillKnownFields(page, ctx.knownAnswers);

    const submitButton = page.getByRole('button', { name: /submit|send my application|apply/i }).first();
    if (!(await submitButton.isVisible().catch(() => false))) {
      return {
        success: false,
        note: 'Formulaire SmartRecruiters non reconnu (bouton de soumission introuvable) — à finaliser manuellement.',
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
        note: 'Le formulaire SmartRecruiters contient des questions personnalisées non renseignées — à finaliser manuellement.',
      };
    }

    const confirmed = await page
      .getByText(/application submitted|thank you for applying|thanks for applying/i)
      .first()
      .isVisible()
      .catch(() => false);

    return confirmed
      ? { success: true }
      : { success: false, note: 'Soumission SmartRecruiters envoyée mais confirmation non détectée — à vérifier manuellement.' };
  }
}
