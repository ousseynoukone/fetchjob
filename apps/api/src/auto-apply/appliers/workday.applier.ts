import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { dismissCookieBanner } from './ats-common';

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

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const applyButton = page.getByRole('button', { name: /^apply$/i }).or(page.getByRole('link', { name: /^apply$/i })).first();
    if (await applyButton.isVisible().catch(() => false)) {
      await applyButton.click();
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
    const autofillInput = page.locator('input[type="file"]').first();
    if (await autofillInput.count().catch(() => 0)) {
      await autofillInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
      await page.waitForTimeout(1500);
    }

    for (let step = 0; step < 8; step++) {
      await fillKnownFields(page, ctx.knownAnswers);

      const errorVisible = await page
        .locator('[role="alert"], [data-automation-id*="error" i]')
        .first()
        .isVisible()
        .catch(() => false);
      if (errorVisible) {
        const unknownFields = await scanInvalidFields(page);
        if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);
        return {
          success: false,
          note: 'Le formulaire Workday contient un champ obligatoire non renseigné — à finaliser manuellement.',
        };
      }

      const submitButton = page.getByRole('button', { name: /submit/i }).first();
      if (await submitButton.isVisible().catch(() => false)) {
        await submitButton.click();
        await page.waitForTimeout(2000);

        const confirmed = await page
          .getByText(/application submitted|thank you for applying/i)
          .first()
          .isVisible()
          .catch(() => false);

        return confirmed
          ? { success: true }
          : { success: false, note: 'Soumission Workday envoyée mais confirmation non détectée — à vérifier manuellement.' };
      }

      const nextButton = page.getByRole('button', { name: /^next$|^continue$/i }).first();
      if (await nextButton.isVisible().catch(() => false)) {
        await nextButton.click();
        await page.waitForTimeout(1200);
        continue;
      }

      break;
    }

    return {
      success: false,
      note: 'Formulaire Workday non reconnu (étape inattendue) — à finaliser manuellement.',
    };
  }
}
