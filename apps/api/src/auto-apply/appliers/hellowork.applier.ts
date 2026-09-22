import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl, fillIdentityFields, uploadCv, humanFill, findCvFileInput } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';
import { REMOTE_LOGIN_URLS } from '../../platform-credentials/remote-login.service';

// Confirmed live: a stale/invalid HelloWork session doesn't get redirected
// to a login page when clicking "Postuler" on a job posting — it lands on
// HelloWork's own anonymous "Créez votre compte Hellowork et envoyez votre
// candidature !" guest flow instead, which re-asks for Nom/Prénom/Email
// from scratch and offers to create a throwaway account. Checked for
// explicitly below, in addition to the proactive homeUrl check in
// ensureLoggedIn, since either one missing the other is exactly what let a
// dead session silently limp through the guest flow every single time
// instead of ever being reported as a session problem.
const GUEST_ACCOUNT_CREATION_TEXT = /cr[ée]ez votre compte hellowork/i;

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
    const loginResult = await this.ensureLoggedIn(page, ctx);
    if (loginResult) return loginResult;

    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    // Confirmed live: after a morning of retries HelloWork's edge (Azure
    // Application Gateway) answered a job URL with a bare "403 Forbidden".
    // That is a rate/behaviour block, not a missing button.
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (/^\s*403 forbidden|application-gateway|access denied|request blocked/i.test(bodyText) && bodyText.length < 400) {
      await ctx.appendLog?.("HelloWork refuse l'accès à cette page (403) — blocage temporaire côté HelloWork.");
      return {
        success: false,
        blockedByWaf: true,
        note: "HelloWork a refusé l'accès à l'offre (403, protection anti-robot) — à relancer plus tard, en espaçant les tentatives.",
      };
    }

    // Confirmed live with a real session (Canal+ offer, probed step by
    // step): on an external offer the header CTA reads "Postuler sur le
    // site du recruteur" and every click path ends at HelloWork's own
    // redirector, /fr-fr/emplois/redirectionexterne.html?offerId=<id>,
    // which then navigates to the employer's posting by itself (~2s).
    // Going there directly skips the lazy "#postuler" frame, the
    // openInNewTab button and the popup race that failed on 7 offers in
    // one run -- and the destination URL is read straight from the tab.
    const headerCta = (await page.locator('[data-cy="applyButtonHeader"]').first().innerText().catch(() => '')).trim();
    const offerIdMatch = ctx.application.sourceUrl.match(/\/emplois\/(\d+)\.html/);
    if (/sur le site/i.test(headerCta) && offerIdMatch) {
      await ctx.appendLog?.('HelloWork renvoie vers le site du recruteur pour cette offre — passage par son redirecteur...');
      await page
        .goto(`https://www.hellowork.com/fr-fr/emplois/redirectionexterne.html?offerId=${offerIdMatch[1]}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(() => {});
      for (let i = 0; i < 12 && /hellowork\.com/i.test(page.url()); i++) await page.waitForTimeout(1000);
      if (!/hellowork\.com/i.test(page.url()) && /^https?:/.test(page.url())) {
        return { success: false, redirectToExternalUrl: page.url() };
      }
      return {
        success: false,
        note: "HelloWork renvoie vers le site du recruteur mais son redirecteur n'a pas abouti — à traiter manuellement.",
      };
    }

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

    // The header "Postuler" is an anchor to the page's own "#postuler"
    // section, whose content is a LAZY turbo-frame
    // (#offer-detail-step-frame) that only loads once scrolled into view.
    // Confirmed live on two external HelloWork offers (M6, Astek): the
    // instant check below ran before that frame existed, missed the
    // "Postuler sur le site du recruteur" button, and the attempt then
    // spent its whole budget trying to fill a form that wasn't there. Wait
    // for the frame to have rendered SOMETHING actionable first.
    await page
      .locator('#offer-detail-step-frame button, #offer-detail-step-frame a, #offer-detail-step-frame input, #postuler button, #postuler input')
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {});

    // HelloWork can also display an intermediate page: "Finalisez votre candidature sur le site du recruteur"
    // with a button "Postuler sur le site du recruteur".
    const recruiterSiteBtn = page
      .locator('button, a, [role="button"]')
      .filter({ hasText: /site du recruteur|site du partenaire|site de l.entreprise/i })
      .first();
    if (await recruiterSiteBtn.isVisible().catch(() => false)) {
      await ctx.appendLog?.('HelloWork renvoie vers le site du recruteur pour cette offre...');
      const externalRecruiterUrl = await resolveExternalApplyUrl(page, recruiterSiteBtn, /hellowork\.com/i);
      if (externalRecruiterUrl) {
        return { success: false, redirectToExternalUrl: externalRecruiterUrl };
      }
      return {
        success: false,
        note: "HelloWork renvoie vers le site du recruteur mais l'adresse de destination n'a pas pu être lue — à traiter manuellement.",
      };
    }

    if (await page.getByText(GUEST_ACCOUNT_CREATION_TEXT).first().isVisible().catch(() => false)) {
      await ctx.appendLog?.('HelloWork affiche le flux "invité" — la session ne semble pas authentifiée pour cette candidature.');
      return {
        success: false,
        sessionExpired: true,
        note: 'HelloWork a affiché son flux "Créez votre compte" au lieu du formulaire du compte connecté — ouvrez la page Comptes dans FindUrJob et cliquez sur "Ouvrir la session" pour HelloWork afin de vous reconnecter.',
      };
    }

    await fillIdentityFields(page, ctx.cv);

    // `count()`, not `isVisible()` — confirmed live that Playwright's
    // setInputFiles works fine on a hidden input, and HelloWork (like most
    // modern upload UIs) hides the real <input type="file"> behind a
    // styled button/dropzone. Gating on visibility here was silently
    // skipping the upload on every offer that hides it that way — the
    // form then fails validation on a missing CV with no field-level error
    // scanInvalidFields can ever surface (it deliberately excludes file
    // inputs), which is exactly what "à finaliser manuellement" without a
    // useful reason turned out to mean in practice.
    const fileInput = await findCvFileInput(page);
    if (fileInput) {
      await uploadCv(fileInput, ctx).catch(() => {});
    }

    if (ctx.coverLetter) {
      const coverLetterField = page
        .locator('textarea[id*="lettre" i], textarea[aria-label*="lettre" i], textarea[name*="message" i]')
        .first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await humanFill(coverLetterField, ctx.coverLetter).catch(() => {});
      }
    }

    return runFormLoop(page, ctx, this.ai, {
      // Confirmed live: a real HelloWork apply form's actual submit button
      // just reads "Postuler" -- matching neither original alternative --
      // so the fast, free submit-button path never fired, and the AI
      // fallback got invoked on a form that was already fully filled
      // (Prénom/Nom/Email/CV all set) every single time, sometimes stopping
      // rather than confidently clicking a button it wasn't told is safe.
      submitText: /envoyer( ma)? candidature|valider ma candidature|^postuler$/i,
      nextText: /suivant|continuer/i,
      successText:
        /candidature envoyée|votre candidature (a bien été|va être) (envoyée|transmise)|f[ée]licitations ! votre candidature|vous avez été redirigé|postulez directement à une ou plusieurs offres|nous transmettons votre candidature/i,
      successUrl: /candidature-transmise|confirmation|merci/i,
      blockedNote: 'Le formulaire de candidature HelloWork contient un champ non renseigné — à finaliser manuellement.',
      unresolvedNote: 'Soumission HelloWork envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }

  private async ensureLoggedIn(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    await page.goto(SESSION_CHECKS.hellowork.homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await dismissCookieBanner(page);

    const onLoginWall = await SESSION_CHECKS.hellowork.isLoginWallVisible(page);
    if (!onLoginWall) return null; // already have a valid, reused session

    if (
      ctx.credential?.email &&
      ctx.credential?.password &&
      ctx.credential.email !== '(session importée)' &&
      ctx.credential.email !== '(connecté via navigateur intégré)'
    ) {
      await ctx.appendLog?.(`Session expirée — reconnexion automatique HelloWork avec ${ctx.credential.email}...`);
      try {
        await page.goto(REMOTE_LOGIN_URLS.hellowork, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await dismissCookieBanner(page).catch(() => {});
        await page.waitForTimeout(2000);

        const emailField = page.locator('input[name="email2"], input[name="email"]').first();
        const passField = page.locator('input[type="password"]').first();
        if ((await emailField.isVisible().catch(() => false)) && (await passField.isVisible().catch(() => false))) {
          await emailField.fill(ctx.credential.email);
          await passField.fill(ctx.credential.password);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(4000);

          const stillOnWall = await SESSION_CHECKS.hellowork.isLoginWallVisible(page);
          if (!stillOnWall) {
            await ctx.appendLog?.('Reconnexion automatique HelloWork réussie !');
            const state = await page.context().storageState().catch(() => null);
            if (state) {
              await ctx.onSessionUpdated?.(JSON.stringify(state));
            }
            return null;
          }
        }
      } catch (err: any) {
        this.logger.warn(`Auto-relogin HelloWork error: ${err.message}`);
      }
    }

    return {
      success: false,
      sessionExpired: true,
      note: "Session HelloWork absente ou expirée — ouvrez la page Comptes dans Paramètres et connectez-vous via le navigateur intégré.",
    };
  }
}
