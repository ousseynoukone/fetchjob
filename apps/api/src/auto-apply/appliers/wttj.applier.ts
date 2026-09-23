import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl, humanFill, humanClick, uploadCv, splitName, findWttjApplyButton, findCvFileInput, waitForWttjHydration } from './ats-common';
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
    // The apply link's real href only exists after hydration (see
    // waitForWttjHydration) -- read too early, an external offer looks
    // native and gets clicked as one.
    await waitForWttjHydration(page);

    // Confirmed live with the real session: after hydration the HEADER
    // apply link carries the employer URL outright for an external offer
    // (href="https://recruiting.ferchau.com/..." target=_blank). Read it
    // before clicking anything -- the generic "first visible Postuler"
    // search below can land on another control (bottom bar, sidebar)
    // whose click only summons the tracker dialog.
    const headerHref = (await page.locator('[data-testid="job_header-button-apply"]').first().getAttribute('href').catch(() => null)) || '';
    await ctx.appendLog?.(`Lien « Postuler » WTTJ après hydratation : ${headerHref ? headerHref.slice(0, 80) : '(absent)'}`);
    if (/^https?:\/\//i.test(headerHref) && !OWN_DOMAIN.test(headerHref)) {
      return { success: false, redirectToExternalUrl: headerHref };
    }

    const applyButton = await findWttjApplyButton(page);
    if (!applyButton) {
      // Confirmed live on 8 real failures: the listing URL itself had
      // redirected to the employer's OWN career site (agap2's, with its own
      // "Postulez à cette offre dès maintenant !" button) -- WTTJ's
      // data-testid was never going to exist on a foreign page, and this
      // applier gave up on a page that the generic fallback could have
      // handled. Off-domain means "this is an external apply", not "no
      // button": hand the resolved URL back so ATS-by-URL routing (or the
      // generic fallback) gets its shot, exactly as an explicit redirect
      // would.
      if (!OWN_DOMAIN.test(page.url())) {
        return { success: false, redirectToExternalUrl: page.url() };
      }
      return {
        success: false,
        note: "Bouton de candidature Welcome to the Jungle introuvable sur cette offre — à traiter manuellement.",
      };
    }

    const externalUrl = await resolveExternalApplyUrl(page, applyButton, OWN_DOMAIN);
    if (externalUrl) {
      return { success: false, redirectToExternalUrl: externalUrl };
    }

    // Confirmed live (FERCHAU offer): when the click DID open the employer's
    // ATS in another tab, WTTJ itself shows a tracker dialog -- "Avez-vous
    // postulé à ce job ... ? Ce job est géré sur une plateforme externe" --
    // on the page this applier is still driving. That dialog is proof of
    // an external apply even when the popup itself was missed; the href
    // (hydrated by now) or the other open tab gives the URL to follow.
    const trackerDialog = page.getByText(/g[ée]r[ée] sur une plateforme externe|avez-vous postul[ée]/i).first();
    if (await trackerDialog.isVisible().catch(() => false)) {
      const href =
        (await page.locator('[data-testid="job_header-button-apply"]').first().getAttribute('href').catch(() => null)) ||
        (await applyButton.getAttribute('href').catch(() => null));
      // Confirmed live (FERCHAU, logged in): the employer tab can open
      // several seconds AFTER the click -- WTTJ first records the click,
      // then window.open()s -- so a tab that isn't there yet is waited for.
      const findOtherTab = () => page.context().pages().find((p) => p !== page && !OWN_DOMAIN.test(p.url()) && /^https?:/.test(p.url()));
      let otherTab = findOtherTab();
      if (!otherTab) {
        await page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null);
        await page.waitForTimeout(1500);
        otherTab = findOtherTab();
      }
      if (otherTab) await otherTab.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
      const target = href && /^https?:\/\//i.test(href) && !OWN_DOMAIN.test(href) ? href : otherTab?.url() || null;
      await otherTab?.close().catch(() => {});
      if (target) return { success: false, redirectToExternalUrl: target };
      return {
        success: false,
        note: "Welcome to the Jungle indique que cette offre se postule sur une plateforme externe, mais l'adresse n'a pas pu être lue — à traiter manuellement.",
      };
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

    const fileInput = await findCvFileInput(page);
    if (fileInput) {
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
      // Confirmed against a real screenshot of a genuinely successful
      // submission (the modal's own confirmation dialog: "Votre candidature
      // a été envoyée" + "Suivez sa progression dans votre espace de suivi
      // des candidatures."): the old regex required either the bare phrase
      // "candidature envoyée" or "a BIEN été envoyée" -- the real dialog
      // reads "a été envoyée" (no "bien"), so it matched neither branch and
      // every genuinely successful WTTJ submission was reported as
      // unconfirmed. "a (bien )?été" makes "bien" optional instead of
      // required.
      successText: /candidature (a (bien )?été |va être )?(envoyée|transmise)/i,
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
