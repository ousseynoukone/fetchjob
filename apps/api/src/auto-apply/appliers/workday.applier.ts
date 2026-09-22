import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, fillIdentityFields, uploadCv, humanClick, findCvFileInput } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

// Workday (company.wd*.myworkdayjobs.com) is the hardest ATS to automate
// generically: every company runs its own tenant, the flow is a multi-page
// wizard, and it usually asks to create a per-company candidate account.
// This does NOT attempt account creation — each Workday tenant is a
// separate login, unrelated to the platform credentials this app manages,
// so creating one blindly per offer isn't something to do without the
// user's knowledge. Uploading the résumé for autofill and stepping through
// simple "Next" pages is attempted; anything else bails to `needs_review`.
@Injectable()
export class WorkdayApplier implements JobApplier {
  readonly credentialPlatform = null;
  private readonly logger = new Logger(WorkdayApplier.name);

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const applyButton = page.getByRole('button', { name: /apply|postuler/i }).or(page.getByRole('link', { name: /apply|postuler/i })).first();
    if (await applyButton.isVisible().catch(() => false)) {
      await humanClick(page, applyButton).catch(() => applyButton.click().catch(() => {}));
      await page.waitForTimeout(1500);
    }

    const accountWall = await page
      .getByText(/create account|sign in|log in/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (accountWall) {
      return {
        success: false,
        note: 'Cette offre Workday nécessite la création d\'un compte candidat propre à cette entreprise — à traiter manuellement.',
      };
    }

    // `count()`, not `isVisible()` — confirmed live that Playwright's
    // setInputFiles works on a hidden input, same issue found and fixed
    // across every applier here.
    const autofillInput = await findCvFileInput(page);
    if (autofillInput) {
      await uploadCv(autofillInput, ctx).catch(() => {});
      await page.locator('[data-automation-id="spinner"], [class*="spinner" i]').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    // Workday's own resume-parsing autofill usually populates name/email
    // from the uploaded CV, but only fills whatever it left empty — never
    // overrides Workday's own autofill.
    await fillIdentityFields(page, ctx.cv);

    return runFormLoop(page, ctx, this.ai, {
      maxSteps: 8,
      submitText: /submit|soumettre|envoyer/i,
      nextText: /next|continue|suivant|continuer/i,
      successText: /application submitted|thank you for applying/i,
      blockedNote: 'Le formulaire Workday contient un champ obligatoire non renseigné — à finaliser manuellement.',
      unresolvedNote: 'Soumission Workday envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }
}
