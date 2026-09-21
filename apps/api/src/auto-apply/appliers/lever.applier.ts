import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillIfVisible, dismissCookieBanner, uploadCv, humanClick, humanFill } from './ats-common';
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
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await uploadCv(fileInput, ctx).catch(() => {});
    } else {
      // Lever hides the file input behind an "Attach Resume/CV" button.
      const attachButton = page.getByText(/attach resume|attach cv|joindre un cv|parcourir/i).first();
      if (await attachButton.isVisible().catch(() => false)) {
        await humanClick(page, attachButton).catch(() => attachButton.click().catch(() => {}));
        await page.waitForTimeout(500);
        await uploadCv(page.locator('input[type="file"]').first(), ctx).catch(() => {});
      }
    }

    if (ctx.coverLetter) {
      const additionalInfoField = page.locator('textarea[name="comments"], textarea[name*="additional" i]').first();
      if (await additionalInfoField.isVisible().catch(() => false)) {
        await humanFill(additionalInfoField, ctx.coverLetter).catch(() => {});
      }
    }

    await fillKnownFields(page, ctx.knownAnswers);

    return runFormLoop(page, ctx, this.ai, {
      maxSteps: 4,
      submitText: /submit|soumettre|envoyer|apply/i,
      nextText: /next|continue|suivant|continuer/i,
      successText: /application submitted|thank you for applying|thanks for applying|candidature envoyée|merci de votre/i,
      blockedNote: 'Le formulaire Lever contient des questions personnalisées non renseignées — à finaliser manuellement.',
      unresolvedNote: 'Soumission Lever envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }
}
