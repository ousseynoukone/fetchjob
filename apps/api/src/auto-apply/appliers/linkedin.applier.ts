import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl } from './ats-common';

// Best-effort automation of LinkedIn's own UI — LinkedIn does not offer an
// "apply on my behalf" API. Logging in is NOT automated: LinkedIn actively
// hardens its login form against automation (confirmed live — it serves a
// variant with a deliberately hidden input), so this only ever reuses a
// session established manually via `npm run establish-session -- linkedin
// ...`. If that session is missing or has expired, it stops and emails the
// user rather than attempting the login form itself. Verify against the
// real site with AUTO_APPLY_HEADLESS=false before relying on it further.
@Injectable()
export class LinkedInApplier implements JobApplier {
  readonly credentialPlatform = 'linkedin';
  private readonly logger = new Logger(LinkedInApplier.name);

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const loginResult = await this.ensureLoggedIn(page);
    if (loginResult) return loginResult;

    // Login may have redirected away from the job posting — go back to it.
    if (!page.url().includes('/jobs/view/')) {
      await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    const easyApplyButton = page.getByRole('button', { name: /easy apply|postulation simplifiée/i }).first();
    const hasEasyApply = await easyApplyButton.isVisible().catch(() => false);
    if (!hasEasyApply) {
      // No Easy Apply — LinkedIn still shows a plain "Postuler"/"Apply"
      // button for these, which just sends the visitor to the employer's
      // own site (a new tab in some cases, same-page navigation in
      // others) rather than a LinkedIn-hosted form. Follow it instead of
      // giving up, so ATS-by-URL routing (or the generic fallback) gets a
      // real shot at the real form.
      const externalApplyButton = page
        .getByRole('link', { name: /postuler|apply/i })
        .or(page.getByRole('button', { name: /postuler|apply/i }))
        .or(page.locator('a[href*="/safety/go/"], a[data-tracking-control-name*="apply"]'))
        .first();

      if (!(await externalApplyButton.isVisible().catch(() => false))) {
        return {
          success: false,
          note: "Aucun bouton de candidature trouvé sur cette offre LinkedIn — à traiter manuellement.",
        };
      }

      const externalUrl = await resolveExternalApplyUrl(page, externalApplyButton, /linkedin\.com/i);
      if (!externalUrl) {
        return {
          success: false,
          note: "Cette offre LinkedIn ne propose pas de candidature automatisable — à traiter manuellement.",
        };
      }

      return { success: false, redirectToExternalUrl: externalUrl };
    }

    await easyApplyButton.click();
    await page.waitForTimeout(1500);

    // `count()`, not `isVisible()` — confirmed live that Playwright's
    // setInputFiles works on a hidden input; gating on visibility silently
    // skipped the upload whenever LinkedIn hides the real input behind its
    // own styled button, same issue found and fixed across every applier.
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
    }

    if (ctx.coverLetter) {
      const coverLetterField = page
        .locator('textarea[id*="cover" i], textarea[aria-label*="lettre" i], textarea[aria-label*="cover" i]')
        .first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await coverLetterField.fill(ctx.coverLetter).catch(() => {});
      }
    }

    // Step through the multi-page Easy Apply modal. Bounded to 6 steps —
    // a real flow rarely has more, and this guards against an infinite loop
    // if a "Next" button keeps re-appearing without progressing.
    for (let step = 0; step < 6; step++) {
      await fillKnownFields(page, ctx.knownAnswers);

      const errorVisible = await page
        .locator('[role="alert"], .artdeco-inline-feedback--error')
        .first()
        .isVisible()
        .catch(() => false);
      if (errorVisible) {
        const unknownFields = await scanInvalidFields(page);
        if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);
        return {
          success: false,
          note: 'Le formulaire Easy Apply contient une question personnalisée non renseignée — à finaliser manuellement.',
        };
      }

      const submitButton = page.getByRole('button', { name: /submit application|envoyer la candidature/i }).first();
      if (await submitButton.isVisible().catch(() => false)) {
        await submitButton.click();
        await page.waitForTimeout(2000);

        const confirmed = await page
          .getByText(/application sent|candidature envoyée|votre candidature a été envoyée/i)
          .first()
          .isVisible()
          .catch(() => false);

        return confirmed
          ? { success: true }
          : { success: false, note: "Soumission Easy Apply envoyée mais confirmation non détectée — à vérifier manuellement." };
      }

      const nextButton = page.getByRole('button', { name: /next|suivant|review|vérifier/i }).first();
      if (await nextButton.isVisible().catch(() => false)) {
        await nextButton.click();
        await page.waitForTimeout(1200);
        continue;
      }

      break;
    }

    return {
      success: false,
      note: "Formulaire Easy Apply non reconnu (étape inattendue) — à finaliser manuellement.",
    };
  }

  private async ensureLoggedIn(page: Page): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.linkedin.isLoginWallVisible(page);
    if (!onLoginWall) return null; // already have a valid, reused session

    return {
      success: false,
      sessionExpired: true,
      note: "Session LinkedIn absente ou expirée — exécutez `npm run establish-session -- linkedin votre@email.com` sur votre machine pour la rétablir.",
    };
  }
}
