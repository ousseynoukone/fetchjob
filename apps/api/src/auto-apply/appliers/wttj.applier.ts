import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl, humanFill, humanClick, uploadCv, splitName, findWttjApplyButton } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';
import { REMOTE_LOGIN_URLS } from '../../platform-credentials/remote-login.service';

const OWN_DOMAIN = /welcometothejungle\.com/i;

// Every selector/behavior below is transcribed from two real, user-recorded
// sessions covering both outcomes on the SAME button
// ([data-testid="job_header-button-apply"]): one offer opened WTTJ's own
// in-page apply-form-modal, the next opened an external redirect instead
// (confirmed via ats-common.ts's resolveWelcomeToTheJungleApplyUrl already
// reaching that same conclusion anonymously, and reused here again with a
// real session for the exact same "click it, see where it actually goes"
// problem -- this button is genuinely not a plain link with a href worth
// reading cold in either state).
@Injectable()
export class WelcomeToTheJungleApplier implements JobApplier {
  readonly credentialPlatform = 'welcome_to_the_jungle';
  private readonly logger = new Logger(WelcomeToTheJungleApplier.name);

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    const loginResult = await this.ensureLoggedIn(page, ctx);
    if (loginResult) return loginResult;

    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);
    await page.waitForTimeout(2000); // same WAF-challenge/SPA-hydration delay as resolveWelcomeToTheJungleApplyUrl

    const applyButton = await findWttjApplyButton(page);
    if (!applyButton) {
      return {
        success: false,
        note: "Bouton de candidature Welcome to the Jungle introuvable sur cette offre — à traiter manuellement.",
      };
    }

    const externalUrl = await resolveExternalApplyUrl(page, applyButton, OWN_DOMAIN);
    if (externalUrl) {
      return { success: false, redirectToExternalUrl: externalUrl };
    }

    // A stale/invalid session lands back on the signin page instead of the
    // native modal -- same login-wall check catches it here as it would
    // proactively, since a session can die between SessionHealthService's
    // last check and this exact attempt.
    if (await SESSION_CHECKS.welcome_to_the_jungle.isLoginWallVisible(page)) {
      await ctx.appendLog?.('Welcome to the Jungle a renvoyé vers la connexion — la session ne semble plus valide.');
      return {
        success: false,
        sessionExpired: true,
        note: 'Session Welcome to the Jungle absente ou expirée — ouvrez la session depuis Comptes pour la rétablir.',
      };
    }

    const modal = page.locator('[data-testid="apply-form-modal"]').first();
    if (!(await modal.isVisible().catch(() => false))) {
      return {
        success: false,
        note: "Le formulaire de candidature Welcome to the Jungle ne s'est pas ouvert — à traiter manuellement.",
      };
    }

    // Confirmed live: WTTJ pre-fills these from the account's own saved
    // profile -- only overwritten here if genuinely empty, never blindly
    // overwriting a value WTTJ already got right.
    const { first, last } = splitName(ctx.cv.fullName);
    const firstNameField = page.locator('[data-testid="apply-form-field-firstname"]').first();
    if ((await firstNameField.inputValue().catch(() => '')) === '' && first) {
      await humanFill(firstNameField, first).catch(() => {});
    }
    const lastNameField = page.locator('[data-testid="apply-form-field-lastname"]').first();
    if ((await lastNameField.inputValue().catch(() => '')) === '' && last) {
      await humanFill(lastNameField, last).catch(() => {});
    }

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await uploadCv(fileInput, ctx).catch(() => {});
      await page.waitForTimeout(1500);
    }

    if (ctx.coverLetter) {
      const coverLetterField = page.locator('[data-testid="apply-form-field-cover_letter"]').first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await humanFill(coverLetterField, ctx.coverLetter).catch(() => {});
      }
    }

    // Required GDPR consent checkbox -- confirmed live the submit silently
    // fails without it. Always checked, not conditional on anything: every
    // employer's own consent text differs ("...traitées par Protectline...")
    // but the testid and requirement are the same across offers.
    const consentCheckbox = page.locator('[data-testid="apply-form-consent"]').first();
    if (await consentCheckbox.isVisible().catch(() => false)) {
      await humanClick(page, consentCheckbox).catch(() => {});
    }

    return runFormLoop(page, ctx, this.ai, {
      // Confirmed live via the recording: WTTJ's real submit button reads
      // "J'envoie ma candidature !" -- matches either apostrophe character.
      submitText: /j.?envoie ma candidature/i,
      nextText: /suivant|continuer/i,
      // NOT confirmed against real wording (the recording closed the
      // confirmation dialog before its text was captured) -- best-effort,
      // consistent with this file's other success patterns.
      successText: /candidature envoyée|votre candidature (a bien été|va être) (envoyée|transmise)/i,
      blockedNote: 'Le formulaire de candidature Welcome to the Jungle contient un champ non renseigné — à finaliser manuellement.',
      unresolvedNote: 'Soumission Welcome to the Jungle envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }

  private async ensureLoggedIn(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    await page.goto(SESSION_CHECKS.welcome_to_the_jungle.homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await dismissCookieBanner(page);

    const onLoginWall = await SESSION_CHECKS.welcome_to_the_jungle.isLoginWallVisible(page);
    if (!onLoginWall) return null;

    if (
      ctx.credential?.email &&
      ctx.credential?.password &&
      ctx.credential.email !== '(session importée)' &&
      ctx.credential.email !== '(connecté via navigateur intégré)'
    ) {
      await ctx.appendLog?.(`Session expirée — reconnexion automatique Welcome to the Jungle avec ${ctx.credential.email}...`);
      try {
        await page.goto(REMOTE_LOGIN_URLS.welcome_to_the_jungle, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await dismissCookieBanner(page).catch(() => {});
        await page.waitForTimeout(2000);

        const emailField = page.locator('input[name="email"], input[type="email"]').first();
        const passField = page.locator('input[name="password"], input[type="password"]').first();
        if ((await emailField.isVisible().catch(() => false)) && (await passField.isVisible().catch(() => false))) {
          await emailField.fill(ctx.credential.email);
          await passField.fill(ctx.credential.password);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(4000);

          const stillOnWall = await SESSION_CHECKS.welcome_to_the_jungle.isLoginWallVisible(page);
          if (!stillOnWall) {
            await ctx.appendLog?.('Reconnexion automatique Welcome to the Jungle réussie !');
            const state = await page.context().storageState().catch(() => null);
            if (state) {
              await ctx.onSessionUpdated?.(JSON.stringify(state));
            }
            return null;
          }
        }
      } catch (err: any) {
        this.logger.warn(`Auto-relogin WTTJ error: ${err.message}`);
      }
    }

    return {
      success: false,
      sessionExpired: true,
      note: 'Session Welcome to the Jungle absente ou expirée — ouvrez Comptes dans Paramètres pour vous connecter via le navigateur intégré.',
    };
  }
}
