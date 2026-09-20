import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, fillIdentityFields, uploadCv, humanClick, trySolveSlideChallenge } from './ats-common';
import { fillKnownFields } from './form-fields';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

// SmartRecruiters-hosted postings (jobs.smartrecruiters.com) are public, no
// account needed — same rationale as the other ATS appliers.
@Injectable()
export class SmartRecruitersApplier implements JobApplier {
  readonly credentialPlatform = null;

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    // Detect challenge/captcha early — solve slider if present
    const isSlider = await page
      .locator('text="Slide right to secure", text="Glissez vers la droite"')
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (isSlider) {
      await ctx.appendLog?.('Défi anti-robot (slider) détecté sur SmartRecruiters — tentative de résolution...');
      const solved = await trySolveSlideChallenge(page);
      if (solved) {
        await ctx.appendLog?.('Défi anti-robot (slider) résolu avec succès !');
        await page.waitForTimeout(2000);
      } else {
        return {
          success: false,
          note: 'Vérification anti-robot (slider) requise sur SmartRecruiters -- à finaliser manuellement.',
        };
      }
    }

    const isChallenge = await page.locator('text="Verification Required", [class*="captcha" i]').count().catch(() => 0);
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
      await humanClick(page, openFormButton).catch(() => openFormButton.click().catch(() => {}));
      await page.waitForTimeout(2000);
    }

    await fillIdentityFields(page, ctx.cv);

    // `count()`, not `isVisible()` — confirmed live that Playwright's
    // setInputFiles works on a hidden input, same issue found and fixed
    // across every applier here.
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await uploadCv(fileInput, ctx).catch(() => {});
      
      // SmartRecruiters often extracts CV data asynchronously and shows a loading state.
      // Wait for any 'loading' overlay to disappear, or just give it a solid buffer
      // so the form fields have time to populate before the AI starts reading the snapshot.
      await page.locator('[class*="spinner" i], [class*="loading" i], [aria-busy="true"]').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    await fillKnownFields(page, ctx.knownAnswers);

    return runFormLoop(page, ctx, this.ai, {
      maxSteps: 6,
      submitText: /submit|send my application|apply/i,
      nextText: /^next$|^continue$/i,
      successText: /application submitted|thank you for applying|thanks for applying/i,
      blockedNote: 'Le formulaire SmartRecruiters contient des questions personnalisées non renseignées — à finaliser manuellement.',
      unresolvedNote: 'Soumission SmartRecruiters envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }
}
