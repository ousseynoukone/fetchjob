import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, hasSecurityCheck, fillIdentityFields, uploadCv, humanClick, humanFill, trySolveSlideChallenge, findCvFileInput, hasJobClosedIndicator, truncateAtBoundary, tickConsentCheckboxes, clickCvUploadControl } from './ats-common';
import { fillKnownFields } from './form-fields';
import { runFormLoop } from './ai-form-loop';
import { buildFormSnapshot } from './ai-form-snapshot';
import { AiService } from '../../ai/ai.service';

// Confirmed live on Extia's own career site: its reveal button reads
// "It's a match" -- no wordlist can ever fully cover arbitrary branded CTA
// copy (this pattern of playful/gamified apply buttons shows up across
// several French career sites), so this stays a best-effort, growing list
// rather than a claim of full coverage.
const REVEAL_BUTTON_TEXT =
  /postuler|apply now|apply for this job|candidater|je postule|submit application|envoyer ma candidature|it'?s a match|importez? (mon|votre) cv|t[ée]l[ée]charge[rz] (mon|votre) cv|joindre (mon|votre) cv|upload (your |my )?(cv|resume)|remplir le cv/i;
// `^postuler$` used to require the button's ENTIRE accessible name to be
// exactly "Postuler" -- real buttons are far more often phrased "Postuler
// maintenant" / "Postuler à cette offre", which an anchored match always
// missed. Unanchored now, consistent with every other term in this list.
const SUBMIT_BUTTON_TEXT =
  /submit application|submit my application|apply now|postuler|envoyer( ma candidature)?|soumettre|valider ma candidature/i;
// Confirmed live on a France Travail external partner site (jobposting.pro):
// its own real confirmation page reads "Nous accusons réception de votre
// candidature..." — "réception" before "candidature", the reverse word
// order from every existing "candidature (reçue|...)" alternative here, so
// none of them matched and a genuinely successful submission was reported
// as "confirmation non détectée" instead.
const SUCCESS_TEXT =
  /application submitted|application received|thank you for applying|thanks for applying|we('| ha)ve received your application|your application (has been|was) (received|submitted)|candidature (envoyée|reçue|transmise|enregistrée|bien reçue|prise en compte)|accusons? r[ée]ception de (votre |la )?candidature|merci (pour votre candidature|d'avoir postulé)|votre candidature a (bien )?été (envoyée|transmise|enregistrée|prise en compte)/i;

// Some ATS confirmation pages navigate to a distinct URL (a "thank-you" /
// "confirmation" page) rather than showing inline text on the same page --
// checked as an extra signal alongside SUCCESS_TEXT rather than a
// replacement for it, since most confirmations are same-page text and a
// URL-only check would false-positive on unrelated redirects.
const SUCCESS_URL = /thank-?you|confirmation|success|merci|candidature-envoyee|application-submitted/i;

// Job boards where applying requires an account on THAT board -- confirmed
// live one by one (Free-Work, Collective.work, eFinancialCareers,
// Freelance.com): the job page looks open, but "Postuler" only ever leads
// to sign-up / Google sign-in. No session exists for them here, so the
// honest outcome is immediate: named as such, nothing typed anywhere.
const ACCOUNT_ONLY_BOARDS = /efinancialcareers\.|free-work\.|collective\.work|freelance\.com|malt\.(fr|com)|jobteaser\.|jobijoba\.|choosemycompany\.|talents-handicap\./i;

// Job boards that only ever link OUT to the real posting (see apply()).
const AGGREGATOR_OUTBOUND_LINKS: { name: string; host: RegExp; selector: string }[] = [
  { name: 'Adzuna', host: /adzuna\./i, selector: 'a[href*="/land/ad/"], a[data-js="apply-capture-skip"]' },
];

// Last-resort applier for a posting on a platform with no dedicated
// integration (an ATS we don't recognize, a company's own custom career
// page, ...) — confirmed live that this is common: Welcome to the Jungle
// alone redirects to all sorts of systems beyond the four ATS we do handle.
// Rather than immediately handing the candidature back for manual
// follow-up, this makes one honest best-effort attempt using the same
// broad label heuristics a human applicant relies on. Every step degrades
// safely: a field that doesn't exist is simply skipped, a CAPTCHA/security
// check is never worked around, and success is only ever reported on an
// actual confirmation — never assumed just because a button was clicked.
@Injectable()
export class GenericApplier implements JobApplier {
  readonly credentialPlatform = null;

  constructor(private ai: AiService) {}

  async apply(initialPage: Page, ctx: ApplyContext): Promise<ApplyResult> {
    // Reassigned when a "Postuler" click opens the real form in a NEW TAB
    // (confirmed live on handicap-job.com -> talents-handicap.com): every
    // later step then runs on that tab, and it's reported as finalPage so
    // the screenshot shows the right one.
    let page = initialPage;
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Career sites (SuccessFactors, Workday-likes) routinely land, then
    // client-redirect -- confirmed live on Capgemini's: the job URL turned
    // into a "no matching vacancy" search page a couple of seconds after
    // domcontentloaded, AFTER the expired-posting check below had already
    // run against the half-loaded page. Let the network settle first.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await dismissCookieBanner(page);
    await ctx.appendLog?.(`Page employeur chargée (${new URL(page.url()).hostname}) — recherche du formulaire...`);

    // Aggregator listing pages are never the form. Adzuna's "details" page
    // has a "Postuler" that goes through /land/ad/ to the real posting --
    // confirmed live that treating the page as a form ended with the
    // candidate's job title typed into Adzuna's own search box. Resolve
    // the outbound link and hand it back as a redirect instead; if it lands
    // right back on Adzuna (an expired ad bounces to search results), say so.
    if (ACCOUNT_ONLY_BOARDS.test(page.url())) {
      return {
        success: false,
        note: `Cette plateforme (${new URL(page.url()).hostname}) exige un compte pour postuler — candidature à effectuer directement sur le lien de l'offre.`,
      };
    }

    for (const rule of AGGREGATOR_OUTBOUND_LINKS) {
      if (!rule.host.test(page.url())) continue;
      const outbound = page.locator(rule.selector).first();
      const href = await outbound.getAttribute('href').catch(() => null);
      if (!href) {
        return { success: false, note: `${rule.name} n'affiche plus de lien de candidature pour cette annonce (probablement expirée) — à ignorer.` };
      }
      // The outbound link is on the aggregator's own domain and bounces to
      // the real posting: navigate it directly (no click to be blocked by
      // the "Créer une alerte email" promo modal seen live) and read where
      // it ends up.
      await ctx.appendLog?.(`${rule.name} : suivi du lien vers l'annonce d'origine...`);
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      // The bounce is client-side and not instant (confirmed live: the
      // MSA ad had already reached apec.fr in the screenshot while this
      // read, taken 1.5s after load, still saw adzuna.fr and called the ad
      // expired). Poll until the URL actually leaves the aggregator.
      for (let i = 0; i < 12 && rule.host.test(page.url()); i++) await page.waitForTimeout(1000);
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      const target = page.url();
      if (!target || rule.host.test(target)) {
        return { success: false, note: `${rule.name} renvoie vers sa propre page de recherche : l'annonce semble expirée — à ignorer.` };
      }
      return { success: false, redirectToExternalUrl: target };
    }

    if (await hasSecurityCheck(page)) {
      const solved = await trySolveSlideChallenge(page);
      if (!solved) {
        return {
          success: false,
          note: 'Vérification de sécurité affichée par la plateforme — à finaliser manuellement.',
        };
      }
      await page.waitForTimeout(2000);
    }

    // Confirmed live on a Michael Page apply page ("Comment souhaitez-vous
    // postuler ?" -> "Postuler avec mon CV" / "Apply With LinkedIn"): the
    // choice screen is the whole page, there is no form until one is
    // picked, and a single instant isVisible() read right after
    // domcontentloaded missed the button -- the attempt then spent its
    // budget scanning a page with no fields. Waits for it (bounded), checks
    // every match rather than the first, never picks a third-party sign-in
    // ("Apply with LinkedIn/Indeed/Google"), and falls back to any
    // clickable element carrying the wording when the button has no
    // semantic role.
    const THIRD_PARTY_TEXT = /linkedin|indeed|google|facebook|apple|microsoft|seek/i;
    const revealCandidates = page
      .getByRole('link', { name: REVEAL_BUTTON_TEXT })
      .or(page.getByRole('button', { name: REVEAL_BUTTON_TEXT }))
      .or(page.locator('[role="button"], a, button, div[onclick], span[onclick]').filter({ hasText: REVEAL_BUTTON_TEXT }));
    // Two passes: confirmed live that a first "Postuler" (Direct Emploi's)
    // can lead to a SECOND choice screen ("Comment souhaitez-vous
    // postuler ?" -> "Postuler avec mon CV" on Michael Page) before any
    // form exists. The second pass only runs when the first click left
    // the page without a single visible field.
    const visibleFieldCount = () =>
      page.locator('input:not([type=hidden]):not([type=submit]):not([type=button]):visible, textarea:visible, select:visible').count().catch(() => 0);
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0 && (await visibleFieldCount()) > 0) break;
      // Consent first: on JCDecaux's ATS the "Importez votre CV" /
      // "Remplir le CV manuellement" buttons only enable once the data-
      // protection box is ticked.
      if (await tickConsentCheckboxes(page)) await page.waitForTimeout(600);
      let revealButton: import('playwright').Locator | null = null;
      for (let attempt = 0; attempt < (pass === 0 ? 5 : 2) && !revealButton; attempt++) {
        const matches = await revealCandidates.all().catch(() => []);
        for (const candidate of matches) {
          const text = (await candidate.innerText().catch(() => '')).trim();
          if (text.length > 80 || THIRD_PARTY_TEXT.test(text)) continue;
          if (await candidate.isVisible().catch(() => false)) {
            revealButton = candidate;
            break;
          }
        }
        if (!revealButton) await page.waitForTimeout(1000);
      }
      if (!revealButton) break;
      await ctx.appendLog?.(`Clic sur « ${(await revealButton.innerText().catch(() => 'Postuler')).trim().slice(0, 40)} »...`);
      const popupPromise = page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null);
      await humanClick(page, revealButton).catch(() => revealButton!.click().catch(() => {}));
      const popup = await popupPromise;
      if (popup && popup !== page) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await ctx.appendLog?.(`Le formulaire s'est ouvert dans un nouvel onglet (${(() => { try { return new URL(popup.url()).hostname; } catch { return popup.url(); } })()})...`);
        page = popup;
        if (ACCOUNT_ONLY_BOARDS.test(page.url())) {
          return {
            success: false,
            finalPage: page,
            note: `Cette plateforme (${new URL(page.url()).hostname}) exige un compte pour postuler — candidature à effectuer directement sur le lien de l'offre.`,
          };
        }
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      // The click can start a client-side redirect chain (SuccessFactors:
      // job page -> "aucun poste vacant" search page, confirmed live) --
      // let it settle before deciding what this page is.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1000);
      await dismissCookieBanner(page);
    }

    // Checked AFTER the reveal click, not only before it. Confirmed live on
    // three redirect targets in one run (Free-Work, Collective.work,
    // eFinancialCareers): the job page itself looks fine, and it's the
    // "Postuler" click that opens a "Créer un compte" / "Se connecter"
    // wall -- which then got the candidate's email typed into a SIGN-UP
    // form and a "submitted, no confirmation" verdict. An account-only
    // platform is unrecoverable here whatever the wording, so it's named
    // as such instead of fed to the form loop.
    // The posting itself is gone (expired / filled / URL now a search page).
    // Nothing to fill; say so instead of typing into whatever inputs the
    // page happens to have.
    if (await hasJobClosedIndicator(page)) {
      return {
        success: false,
        note: "L'offre n'est plus disponible sur le site du recruteur (expirée ou pourvue) — à ignorer.",
      };
    }

    const accountWall = await this.detectAccountWall(page);
    if (accountWall) {
      return {
        success: false,
        note: `Cette plateforme (${new URL(page.url()).hostname}) exige un compte pour postuler (${accountWall}) — candidature à effectuer directement sur le lien de l'offre.`,
      };
    }

    // A job-search page is not an application form (Safran's career site,
    // confirmed live: the job URL now lands on "Offres d'emploi" with
    // keyword/contract/location filters, and the identity fill then spent
    // the whole budget wrestling with its dropdowns).
    const preSnapshot = await buildFormSnapshot(page).catch(() => ({ fields: [], buttons: [] }));
    const searchLike = /recherche|mots?-cl[ée]s?|^rechercher|fr[ée]quence.*alerte|cr[ée]er une alerte|job title, keywords|search jobs|localisation du poste|type (de )?contrat|m[ée]tier \/ emploi|statut \(csp\)/i;
    if (preSnapshot.fields.length >= 2 && preSnapshot.fields.every((f) => searchLike.test(f.label))) {
      return {
        success: false,
        note: "La page d'arrivée est une page de recherche d'offres, pas un formulaire de candidature (offre probablement retirée) — à ignorer.",
      };
    }

    // Each preparatory step is bounded and logged when it overruns: a hung
    // step used to be indistinguishable from a slow one ("150s sans
    // réponse" with the journal stuck on "Remplissage...").
    const bounded = async (label: string, work: () => Promise<unknown>, ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      });
      const outcome = await Promise.race([work().then(() => 'done' as const).catch(() => 'done' as const), timeout]);
      clearTimeout(timer);
      if (outcome === 'timeout') await ctx.appendLog?.(`Étape « ${label} » trop longue (> ${Math.round(ms / 1000)}s) — poursuite sans elle.`);
    };

    await ctx.appendLog?.('Remplissage des coordonnées et du CV...');
    await bounded('coordonnées', () => fillIdentityFields(page, ctx.cv), 30000);

    const hasPasswordField = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    // Confirmed live: a France Travail offer redirected out to Indeed's own
    // "Créez un compte ou connectez-vous" gate -- an OAuth-style picker
    // (Google/Facebook/email continue buttons), no password field anywhere
    // on that first screen, so hasPasswordField alone missed it entirely
    // and left the AI fallback grinding on a page with no real application
    // form on it for the rest of the attempt's budget. Any platform's own
    // "you need an account for this" wording is just as unrecoverable as a
    // bare password field -- same outcome either way, so it's checked for
    // directly instead of only inferring it from ONE specific field type.
    const hasLoginPrompt = await page
      .getByText(
        /cr[ée]ez un compte ou connectez[- ]vous|connectez[- ]vous pour postuler|se connecter pour postuler|sign in or create an account|log ?in to apply|sign in to apply/i,
      )
      .first()
      .isVisible()
      .catch(() => false);
    if (hasPasswordField || hasLoginPrompt) {
      return {
        success: false,
        note: 'Connexion requise sur la plateforme (compte tiers, ex: Indeed, Welcome to the Jungle) — candidature à effectuer directement sur le lien de l\'offre.',
      };
    }

    await bounded(
      'CV',
      async () => {
        const fileInput = await findCvFileInput(page);
        if (fileInput) {
          await uploadCv(fileInput, ctx).catch(() => {});
        } else if (await clickCvUploadControl(page)) {
          await ctx.appendLog?.("CV transmis via le sélecteur de fichier du site...");
        }
      },
      20000,
    );

    if (ctx.coverLetter) {
      await bounded(
        'lettre',
        () =>
          this.fillFirstMatch(
            page,
            [/cover letter|lettre de motivation|motivation|message|additional information|informations compl[ée]mentaires/i],
            ctx.coverLetter,
          ),
        20000,
      );
    }

    await bounded('réponses connues', () => fillKnownFields(page, ctx.knownAnswers), 30000);

    // Confirmed live on a Cegedim career-site apply-time screenshot: its
    // cookie-consent modal was STILL sitting there, undismissed, this deep
    // into the flow — a slower-loading consent-management script can render
    // it after the single dismiss attempt right after page.goto() already
    // ran. A second, cheap attempt right before submission catches that
    // case without duplicating work on sites where it was already cleared.
    await dismissCookieBanner(page);

    await ctx.appendLog?.('Analyse du formulaire et réponses aux questions...');
    const result = await runFormLoop(page, ctx, this.ai, {
      maxSteps: 5,
      submitText: SUBMIT_BUTTON_TEXT,
      nextText: /continue|continuer|next|suivant/i,
      successText: SUCCESS_TEXT,
      successUrl: SUCCESS_URL,
      blockedNote:
        'Aucun formulaire de candidature exploitable trouvé, ou des questions restent sans réponse — à finaliser manuellement.',
      unresolvedNote: 'Formulaire soumis mais confirmation non détectée — à vérifier manuellement.',
    });

    if (!result.success && (await hasSecurityCheck(page))) {
      const solved = await trySolveSlideChallenge(page);
      if (!solved) {
        return {
          success: false,
          note: 'Vérification de sécurité affichée après soumission — à finaliser manuellement.',
        };
      }
      await page.waitForTimeout(2000);
    }

    return page === initialPage ? result : { ...result, finalPage: page };
  }

  // "You need an account here": a visible password field, an explicit
  // sign-in-to-apply sentence, or a signup/login dialog (both a
  // "Créer un compte"-style and a "Se connecter"-style control visible at
  // once inside a dialog). Returns what it saw, for the note, or null.
  private async detectAccountWall(page: Page): Promise<string | null> {
    if (await page.locator('input[type="password"]:visible').first().isVisible().catch(() => false)) return 'mot de passe demandé';
    // A sign-up page (heading "Création de compte" / "Create your account")
    // is never an application form -- and must never be filled in.
    const signupHeading = page.locator('h1, h2, h3, legend').filter({ hasText: /cr[ée]ation de compte|cr[ée]er (mon|votre|un) compte|create (an|your) account|sign up/i }).first();
    if (await signupHeading.isVisible().catch(() => false)) return 'page de création de compte';
    const loginSentence = page
      .getByText(
        /cr[ée]ez un compte ou connectez[- ]vous|connectez[- ]vous pour postuler|se connecter pour postuler|sign in or create an account|log ?in to apply|sign in to apply|rejoignez[- ]nous pour postuler/i,
      )
      .first();
    if (await loginSentence.isVisible().catch(() => false)) return 'connexion requise';
    const signup = page.locator('a, button, [role="button"]').filter({ hasText: /cr[ée]er (un|mon) compte|inscription|s'inscrire|sign ?up|register|nous rejoindre/i }).first();
    const login = page.locator('a, button, [role="button"]').filter({ hasText: /^se connecter$|^connexion$|^log ?in$|^sign ?in$/i }).first();
    const dialog = page.locator('[role="dialog"]:visible, .modal:visible, [class*="modal" i]:visible').first();
    if ((await dialog.isVisible().catch(() => false)) && (await signup.isVisible().catch(() => false)) && (await login.isVisible().catch(() => false))) {
      return 'fenêtre « créer un compte / se connecter »';
    }
    return null;
  }

  // Tries each label pattern in turn (first visible match wins) — a plain
  // getByLabel(onePattern) only ever covers one phrasing, so every field
  // needs a short list of alternatives rather than a single regex.
  private async fillFirstMatch(page: Page, patterns: RegExp[], value: string | undefined | null): Promise<boolean> {
    if (!value) return false;
    for (const pattern of patterns) {
      const locator = page.getByLabel(pattern).or(page.getByPlaceholder(pattern)).first();
      if (await locator.isVisible().catch(() => false)) {
        // A "message / informations complémentaires" box is not a cover
        // letter field: sites cap it (Lila: 1 000 chars, enforced only at
        // submit, no maxlength attribute). Only a field actually labelled
        // as a cover letter gets the full text.
        const label = await locator.evaluate((e: any) => `${e.labels?.[0]?.textContent || ''} ${e.getAttribute('placeholder') || ''} ${e.name || ''}`).catch(() => '');
        const isCoverLetterField = /lettre de motivation|cover letter|motivation/i.test(label);
        await humanFill(locator, isCoverLetterField ? value : truncateAtBoundary(value, 1000)).catch(() => {});
        return true;
      }
    }
    return false;
  }
}
