import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillIfVisible, dismissCookieBanner, uploadCv, humanClick, humanFill, findCvFileInput } from './ats-common';
import { fillKnownFields } from './form-fields';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

// Lever-hosted application forms (jobs.lever.co) are public, no account
// needed — same rationale as GreenhouseApplier for having no credential
// platform. Lever uses a single "Full Name" field rather than first/last.
@Injectable()
export class LeverApplier implements JobApplier {
  readonly credentialPlatform = null;

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const revealFormLink = page.getByRole('link', { name: /apply|postuler/i }).first();
    if (await revealFormLink.isVisible().catch(() => false)) {
      await humanClick(page, revealFormLink).catch(() => revealFormLink.click().catch(() => {}));
      await page.waitForTimeout(1000);
    }

    await fillIfVisible(page.locator('input[name="name"]').first(), ctx.cv.fullName);
    await fillIfVisible(page.locator('input[name="email"]').first(), ctx.cv.email);
    await fillIfVisible(page.locator('input[name="phone"]').first(), ctx.cv.phone);

    // `count()`, not `isVisible()` — confirmed live that Playwright's
    // setInputFiles works fine on a hidden input, so this only needs the
    // "Attach Resume/CV" button fallback when the input isn't in the DOM
    // at all yet, not merely whenever it happens to be hidden.
    const fileInput = await findCvFileInput(page);
    if (fileInput) {
      await uploadCv(fileInput, ctx).catch(() => {});
    } else {
      // Lever hides the file input behind an "Attach Resume/CV" button.
      const attachButton = page.getByText(/attach resume|attach cv|joindre un cv|parcourir/i).first();
      if (await attachButton.isVisible().catch(() => false)) {
        await humanClick(page, attachButton).catch(() => attachButton.click().catch(() => {}));
        await page.waitForTimeout(500);
        const retryInput = await findCvFileInput(page);
        if (retryInput) await uploadCv(retryInput, ctx).catch(() => {});
      }
    }

    if (ctx.coverLetter) {
      const additionalInfoField = page.locator('textarea[name="comments"], textarea[name*="additional" i]').first();
      if (await additionalInfoField.isVisible().catch(() => false)) {
        await humanFill(additionalInfoField, ctx.coverLetter).catch(() => {});
      }
    }

    await fillKnownFields(page, ctx.knownAnswers);

    // Confirmed live (MARGO): Lever's "Current location" is a geocoded
    // autocomplete -- typed text alone ("Ile de saint Denis") is rejected
    // at submit; the value only counts once one of its
    // `.dropdown-location` suggestions is clicked. Typed by the known-
    // answer pass above (or here from the CV's location), then the first
    // suggestion is picked; "Paris, France" as a last resort, since a
    // French candidate's exact commune matters less than a valid pick.
    // Lever parses the uploaded résumé asynchronously ("Analyzing resume...")
    // and then overwrites fields from it -- including the location, which
    // it sets as plain text, undoing any selection made earlier (confirmed
    // live: the error came back with the spinner still visible). Wait for
    // the parse to finish, and re-do the selection right before submit.
    await page
      .getByText(/analyzing resume|analyse du cv|analyzing/i)
      .first()
      .waitFor({ state: 'hidden', timeout: 25000 })
      .catch(() => {});
    const locationInput = page.locator('#location-input, input[name="location"]').first();
    const selectLocation = async () => {
      if (!(await locationInput.isVisible().catch(() => false))) return;
      const pickSuggestion = async () => {
        await page.waitForTimeout(2000);
        const suggestion = page.locator('.dropdown-location, .dropdown-results .dropdown-location').filter({ visible: true }).first();
        if (!(await suggestion.isVisible().catch(() => false))) return false;
        // Confirmed live: a mouse click on the suggestion put its text in
        // the box, yet Lever still answered "Please select a location from
        // the dropdown menu" on submit -- its selection state is set by
        // the keyboard path. ArrowDown + Enter first, click as fallback.
        await locationInput.press('ArrowDown').catch(() => {});
        await page.waitForTimeout(250);
        await locationInput.press('Enter').catch(() => {});
        await page.waitForTimeout(600);
        if (await suggestion.isVisible().catch(() => false)) {
          await humanClick(page, suggestion).catch(() => suggestion.click().catch(() => {}));
          await page.waitForTimeout(600);
        }
        return true;
      };
      const current = (await locationInput.inputValue().catch(() => '')).trim();
      const attempts = [current, ctx.cv.location || '', 'Paris, France'].filter((v, i, arr) => v && arr.indexOf(v) === i);
      for (const value of attempts) {
        if ((await locationInput.inputValue().catch(() => '')).trim() !== value) {
          await humanFill(locationInput, value).catch(() => {});
        } else {
          // Re-open the suggestions for text that is already there.
          await locationInput.click({ timeout: 3000 }).catch(() => {});
          await locationInput.press('End').catch(() => {});
          await locationInput.press('Space').catch(() => {});
          await locationInput.press('Backspace').catch(() => {});
        }
        if (await pickSuggestion()) break;
      }
    };
    await selectLocation();

    return runFormLoop(page, ctx, this.ai, {
      beforeSubmit: selectLocation,
      maxSteps: 4,
      submitText: /submit|soumettre|envoyer|apply/i,
      nextText: /next|continue|suivant|continuer/i,
      successText: /application submitted|thank you for applying|thanks for applying|candidature envoyée|merci de votre/i,
      blockedNote: 'Le formulaire Lever contient des questions personnalisées non renseignées — à finaliser manuellement.',
      unresolvedNote: 'Soumission Lever envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }
}
