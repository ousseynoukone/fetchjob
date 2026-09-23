import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, humanClick, humanFill, uploadCv, handleUniversalEmailOtp, hasSecurityCheck, trySolveSlideChallenge, findCvFileInput, hasAlreadyAppliedIndicator } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';
import { GmailOtpService } from '../../common/gmail-otp.service';

// scraping.service.ts's fetchApecOffers builds the stored sourceUrl as
// .../emploi/detail-offre/{numeroOffre} -- the apply page needs that same
// numeroOffre in its own hash-routed URL (see APPLY_URL below).
function extractNumeroOffre(sourceUrl: string): string | null {
  const match = sourceUrl.match(/detail-offre\/([0-9A-Za-z]+)/);
  return match ? match[1] : null;
}

// Every selector/URL/button-text/success-text below is transcribed directly
// from a real, user-recorded application on APEC (a Chrome DevTools
// Recorder export covering an actual login + submit + confirmation) --
// none of it guessed, unlike the first pass at this file's WTTJ sibling.
@Injectable()
export class ApecApplier implements JobApplier {
  readonly credentialPlatform = 'apec';
  private readonly logger = new Logger(ApecApplier.name);

  constructor(
    private ai: AiService,
    private gmailOtp: GmailOtpService,
  ) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    const numeroOffre = extractNumeroOffre(ctx.application.sourceUrl);
    if (!numeroOffre) {
      return {
        success: false,
        note: "Impossible d'identifier le numéro d'offre APEC à partir de son URL — à traiter manuellement.",
      };
    }

    // Confirmed live (probed with the real session, 3 APEC offers): the
    // offer page's own apply control tells internal from external apart --
    // "Postuler" linking to ...promotion/<id>?to=int for APEC's own form,
    // "Postuler sur le site du partenaire" linking to ...?to=ext for a
    // partner posting. Forcing ?to=int on a partner offer shows the promo
    // interstitial whose "Postuler" then does strictly nothing (no request,
    // no navigation), which is where three attempts died. Read the offer
    // page first; a partner offer is followed to the partner instead.
    const offerPageUrl = `https://www.apec.fr/candidat/recherche-emploi.html/emploi/detail-offre/${numeroOffre}`;
    await page.goto(offerPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);
    await page.waitForTimeout(2500);
    if (await hasAlreadyAppliedIndicator(page)) {
      await ctx.appendLog?.('APEC indique que cette candidature a déjà été envoyée.');
      return { success: true, note: 'Candidature déjà enregistrée sur APEC (« Vous avez déjà postulé à cette offre »).' };
    }
    const offerApplyLink = page.locator('a, button').filter({ hasText: /postuler/i }).filter({ visible: true }).first();
    const offerApplyHref = (await offerApplyLink.getAttribute('href').catch(() => null)) || '';
    const offerApplyText = (await offerApplyLink.innerText().catch(() => '')).trim();
    const isPartnerOffer = /to=ext/i.test(offerApplyHref) || /site du partenaire|site de l.entreprise|site du recruteur/i.test(offerApplyText);
    const applyUrl = `https://www.apec.fr/candidat/recherche-emploi/postuler-a-une-offre.html#candidature/promotion/${numeroOffre}?to=${isPartnerOffer ? 'ext' : 'int'}`;
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);
    await page.waitForTimeout(2000);

    // Confirmed live on an Adzuna -> APEC hop: APEC answered the apply
    // route with its "Création de compte" page (session not honoured on
    // that path) and the form loop started filling the SIGN-UP form. An
    // account-creation page is never a candidature form -- stop here.
    if (await page.getByText(/cr[ée]ation de compte|cr[ée]er (mon|votre|un) compte/i).first().isVisible().catch(() => false)) {
      await ctx.appendLog?.("APEC affiche « Création de compte » au lieu du formulaire — la session n'a pas été reconnue sur cette page.");
      return {
        success: false,
        sessionExpired: true,
        note: "APEC a demandé la création d'un compte au lieu d'ouvrir le formulaire — session non reconnue, à rouvrir depuis Comptes puis relancer.",
      };
    }

    if (isPartnerOffer) {
      await ctx.appendLog?.('Offre APEC gérée sur le site du partenaire — suivi de la redirection...');
      const interstitialBtn = page.locator('button, a, [role="button"]').filter({ hasText: /^\s*postuler\s*$/i }).filter({ visible: true }).first();
      const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
      if (await interstitialBtn.isVisible().catch(() => false)) {
        await humanClick(page, interstitialBtn).catch(() => interstitialBtn.click().catch(() => {}));
      }
      const popup = await popupPromise;
      let target: string | null = null;
      if (popup) {
        await popup.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        await popup.waitForTimeout(1000);
        target = popup.url();
        await popup.close().catch(() => {});
      } else {
        for (let i = 0; i < 8 && /apec\.fr/i.test(page.url()); i++) await page.waitForTimeout(1000);
        target = page.url();
      }
      if (target && /^https?:/.test(target) && !/apec\.fr/i.test(target)) {
        return { success: false, redirectToExternalUrl: target };
      }
      return {
        success: false,
        note: "Offre APEC à postuler sur le site du partenaire, mais l'adresse du partenaire n'a pas pu être lue — à traiter manuellement.",
      };
    }

    // Confirmed live (WINSIDE offer): APEC redirects a repeat visit to the
    // offer page with "Vous avez déjà postulé à cette offre" and no form --
    // the candidature exists on APEC's side, so this is a success to
    // record, not a "champ non renseigné" to send to manual review.
    if (await hasAlreadyAppliedIndicator(page)) {
      await ctx.appendLog?.('APEC indique que cette candidature a déjà été envoyée.');
      return { success: true, note: 'Candidature déjà enregistrée sur APEC (« Vous avez déjà postulé à cette offre »).' };
    }

    if (await hasSecurityCheck(page)) {
      const solved = await trySolveSlideChallenge(page);
      if (!solved) {
        return {
          success: false,
          note: 'CAPTCHA ou test anti-robot détecté au chargement — veuillez valider la candidature manuellement ou rafraîchir la session.',
        };
      }
      await page.waitForTimeout(2000);
    }

    // Confirmed live: with no valid session, the SAME #emailid/#password
    // login fields the recording used (there, inline on this apply page,
    // via APEC's own apec-candidature-login component) appear instead of
    // the CV/message form below. Never auto-filled here -- same posture as
    // every other account-based applier in this file, only reuses a
    // session established through the in-app remote-login flow.
    if (await SESSION_CHECKS.apec.isLoginWallVisible(page)) {
      if (
        ctx.credential?.email &&
        ctx.credential?.password &&
        ctx.credential.email !== '(session importée)' &&
        ctx.credential.email !== '(connecté via navigateur intégré)'
      ) {
        await ctx.appendLog?.(`Session expirée — reconnexion automatique APEC avec ${ctx.credential.email}...`);
        const emailField = page.locator('#emailid, input[name="emailid"], input[type="email"]').first();
        await emailField.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        const passField = page.locator('#password, input[name="password"], input[type="password"]').first();
        if ((await emailField.isVisible().catch(() => false)) && (await passField.isVisible().catch(() => false))) {
          await emailField.fill(ctx.credential.email);
          await passField.fill(ctx.credential.password);
          const submitBtn = page.locator('button.popin-btn-primary, button:has-text("Se connecter"), button[type="submit"], .btn-connexion').first();
          if (await submitBtn.isVisible().catch(() => false)) {
            await humanClick(page, submitBtn).catch(() => submitBtn.click({ timeout: 5000 }).catch(() => {}));
          } else {
            await passField.press('Enter');
          }
          await page.waitForTimeout(4000);

          if (await hasSecurityCheck(page)) {
            const solved = await trySolveSlideChallenge(page);
            if (!solved) {
              return {
                success: false,
                note: 'CAPTCHA ou test anti-robot détecté après connexion — veuillez valider la candidature manuellement ou rafraîchir la session.',
              };
            }
            await page.waitForTimeout(2000);
          }

          // Check if APEC triggered email 2FA / OTP verification
          await handleUniversalEmailOtp(page, 'apec', ctx.userId, this.gmailOtp, {
            log: (m) => ctx.appendLog?.(m),
            warn: (m) => ctx.appendLog?.(`⚠️ ${m}`),
          });

          if (!await SESSION_CHECKS.apec.isLoginWallVisible(page)) {
            await ctx.appendLog?.('Reconnexion automatique APEC réussie !');
            const state = await page.context().storageState().catch(() => null);
            if (state) {
              await ctx.onSessionUpdated?.(JSON.stringify(state));
            }
          }
        }
      }

      if (await SESSION_CHECKS.apec.isLoginWallVisible(page)) {
        await ctx.appendLog?.('APEC a affiché le formulaire de connexion — la session ne semble plus valide.');
        return {
          success: false,
          sessionExpired: true,
          note: 'Session APEC absente ou expirée — ouvrez la session depuis Comptes pour la rétablir.',
        };
      }
    }

    // Confirmed live (Groupe Talents Handicap offer): APEC can put a promo
    // interstitial in front of the form -- "Vous êtes sur le point de
    // postuler" / "Besoin d'échanger sur votre projet professionnel ?" with
    // a "Poursuivez votre candidature — Postuler" button. Without that
    // click there is no form, and the loop reported a missing field.
    const interstitialTitle = page.getByText(/sur le point de postuler|poursuivez votre candidature/i).first();
    if (await interstitialTitle.isVisible().catch(() => false)) {
      const continueBtn = page.locator('button, a, [role="button"]').filter({ hasText: /^\s*postuler\s*$/i }).filter({ visible: true }).first();
      if (await continueBtn.isVisible().catch(() => false)) {
        await ctx.appendLog?.("APEC affiche une page intermédiaire — clic sur « Postuler » pour ouvrir le formulaire...");
        // Natural human pause before clicking
        await page.waitForTimeout(1000 + Math.random() * 1500);
        await humanClick(page, continueBtn).catch(() => continueBtn.click().catch(() => {}));
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await dismissCookieBanner(page);

        if (await hasSecurityCheck(page)) {
          await ctx.appendLog?.('CAPTCHA anti-robot DataDome détecté sur APEC — tentative de résolution automatique du glisseur...');
          const solved = await trySolveSlideChallenge(page);
          if (!solved) {
            return {
              success: false,
              note: 'CAPTCHA DataDome détecté sur APEC — bloqué par la sécurité du site. Candidature à valider manuellement.',
            };
          }
          await ctx.appendLog?.('CAPTCHA DataDome résolu avec succès !');
          await page.waitForTimeout(2000);
        }
      }
    }

    // "Je préfère joindre [mon CV]" vs "Je candidate [avec le CV du site]" --
    // a real choice confirmed in the recording between APEC's own stored CV
    // and a fresh upload. Always want the fresh one (this campaign's
    // AI-adapted CV for this specific offer), not whatever happens to be on
    // file at APEC from some earlier, unrelated upload.
    const attachOwnCv = page.getByText(/je pr[ée]f[èe]re joindre/i).first();
    if (await attachOwnCv.isVisible().catch(() => false)) {
      await humanClick(page, attachOwnCv).catch(() => {});
      await page.waitForTimeout(500);
    }

    const fileInput = await findCvFileInput(page);
    if (fileInput) {
      await uploadCv(fileInput, ctx).catch(() => {});
    }

    if (ctx.coverLetter) {
      // "Ajouter un message au recruteur ?" -- an accordion tab the
      // recording opened before the #comment textarea underneath it became
      // fillable.
      const messageTab = page.getByText(/ajouter un message au recruteur/i).first();
      if (await messageTab.isVisible().catch(() => false)) {
        await humanClick(page, messageTab).catch(() => {});
        await page.waitForTimeout(500);
      }
      const commentField = page.locator('#comment').first();
      if (await commentField.isVisible().catch(() => false)) {
        await humanFill(commentField, ctx.coverLetter);
      }
    }

    // The recording's own additional ng-select dropdowns (under
    // #comp_additional-data) aren't touched explicitly here -- their exact
    // meaning (availability date? salary expectations?) isn't confirmed,
    // and ng-select is a custom Angular widget a native <select> handler
    // can't drive anyway. Left to the AI-driven fallback below, which reads
    // whatever's actually visible on the page rather than assuming.
    return runFormLoop(page, ctx, this.ai, {
      // Confirmed live via the recording: APEC's real submit button reads
      // exactly "Envoyer ma candidature".
      submitText: /envoyer ma candidature/i,
      nextText: /suivant|continuer/i,
      successText: /votre candidature a [ée]t[ée] envoy[ée]e/i,
      successUrl: /promotion-de-service|confirmation/i,
      blockedNote: 'Le formulaire de candidature APEC contient un champ non renseigné — à finaliser manuellement.',
      unresolvedNote: 'Soumission APEC envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }
}
