import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl, fillIdentityFields } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

// Same best-effort/defensive posture as the other account-based appliers.
// Login is NOT automated — HelloWork runs a real bot-detection check
// (FriendlyCaptcha) that failed outright against a headless browser in
// live testing ("Échec de la vérification — Browser check failed"), so
// this only ever reuses a session established manually via
// `npm run establish-session -- hellowork ...`.
@Injectable()
export class HelloWorkApplier implements JobApplier {
  readonly credentialPlatform = 'hellowork';
  private readonly logger = new Logger(HelloWorkApplier.name);

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const loginResult = await this.ensureLoggedIn(page);
    if (loginResult) return loginResult;

    const applyButton = page.getByRole('button', { name: /^postuler/i }).or(page.getByRole('link', { name: /^postuler/i })).first();
    const hasApplyButton = await applyButton.isVisible().catch(() => false);
    if (!hasApplyButton) {
      return {
        success: false,
        note: "Bouton de candidature HelloWork introuvable sur cette offre — à traiter manuellement.",
      };
    }

    // Clicking "Postuler" here can either open HelloWork's own in-platform
    // form (the common case, handled below) or send the visitor straight to
    // the employer's own site (a new tab or a same-page navigation) — this
    // resolves which one happened and, for the external case, follows it
    // instead of giving up, so ATS-by-URL routing (or the generic fallback)
    // gets a real shot at the real form.
    const externalUrl = await resolveExternalApplyUrl(page, applyButton, /hellowork\.com/i);
    if (externalUrl) {
      return { success: false, redirectToExternalUrl: externalUrl };
    }

    // `count()`, not `isVisible()` — confirmed live that Playwright's
    // setInputFiles works fine on a hidden input, and HelloWork (like most
    // modern upload UIs) hides the real <input type="file"> behind a
    // styled button/dropzone. Gating on visibility here was silently
    // skipping the upload on every offer that hides it that way — the
    // form then fails validation on a missing CV with no field-level error
    // scanInvalidFields can ever surface (it deliberately excludes file
    // inputs), which is exactly what "à finaliser manuellement" without a
    // useful reason turned out to mean in practice.
    await fillIdentityFields(page, ctx.cv);

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
    }

    if (ctx.coverLetter) {
      const coverLetterField = page
        .locator('textarea[id*="lettre" i], textarea[aria-label*="lettre" i], textarea[name*="message" i]')
        .first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await coverLetterField.fill(ctx.coverLetter).catch(() => {});
      }
    }

    return runFormLoop(page, ctx, this.ai, {
      submitText: /envoyer( ma)? candidature|valider ma candidature/i,
      nextText: /suivant|continuer/i,
      successText: /candidature envoyée|votre candidature a bien été (envoyée|transmise)/i,
      blockedNote: 'Le formulaire de candidature HelloWork contient un champ non renseigné — à finaliser manuellement.',
      unresolvedNote: 'Soumission HelloWork envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }

  private async ensureLoggedIn(page: Page): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.hellowork.isLoginWallVisible(page);
    if (!onLoginWall) return null; // already have a valid, reused session

    return {
      success: false,
      sessionExpired: true,
      note: "Session HelloWork absente ou expirée — exécutez `npm run establish-session -- hellowork votre@email.com` sur votre machine pour la rétablir.",
    };
  }
}
