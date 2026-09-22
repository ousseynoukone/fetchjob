import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, fillIdentityFields, uploadCv, humanClick, humanFill, findCvFileInput } from './ats-common';
import { fillKnownFields } from './form-fields';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

// Greenhouse-hosted application forms (boards.greenhouse.io, job-boards.
// greenhouse.io) are public and need no account login — the form sits on
// the job posting page itself. No credential platform, since this isn't
// one account shared across offers: every company runs its own instance.
@Injectable()
export class GreenhouseApplier implements JobApplier {
  readonly credentialPlatform = null;

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const revealFormLink = page
      .getByRole('link', { name: /apply|postuler/i })
      .or(page.getByRole('button', { name: /apply|postuler/i }))
      .first();
    if (await revealFormLink.isVisible().catch(() => false)) {
      await humanClick(page, revealFormLink).catch(() => revealFormLink.click().catch(() => {}));
      await page.waitForTimeout(1000);
    }

    await fillIdentityFields(page, ctx.cv);

    // `count()`, not `isVisible()` — confirmed live that Playwright's
    // setInputFiles works on a hidden input; gating on visibility silently
    // skipped the upload whenever Greenhouse hides the real input behind
    // its own styled button, same issue found and fixed across every applier.
    const fileInput = await findCvFileInput(page);
    if (fileInput) {
      await uploadCv(fileInput, ctx).catch(() => {});
    }

    if (ctx.coverLetter) {
      const coverLetterField = page.locator('textarea[id*="cover" i], textarea[aria-label*="cover" i]').first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await humanFill(coverLetterField, ctx.coverLetter).catch(() => {});
      }
    }

    await fillKnownFields(page, ctx.knownAnswers);

    return runFormLoop(page, ctx, this.ai, {
      maxSteps: 4,
      submitText: /submit|soumettre|envoyer|apply|postuler/i,
      nextText: /next|continue|suivant|continuer/i,
      successText: /application submitted|thank you for applying|thanks for applying|candidature envoyée|merci de votre/i,
      blockedNote: 'Le formulaire Greenhouse contient des questions personnalisées non renseignées — à finaliser manuellement.',
      unresolvedNote: 'Soumission Greenhouse envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }
}
