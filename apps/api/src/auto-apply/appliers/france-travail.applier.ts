import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl, fillIdentityFields, uploadCv, handleUniversalEmailOtp, findCvFileInput, humanClick, truncateAtBoundary } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';
import { REMOTE_LOGIN_URLS } from '../../platform-credentials/remote-login.service';
import { GmailOtpService } from '../../common/gmail-otp.service';

// France Travail aggregates postings from many partner sites — a large
// share of `sourceUrl`s point at the employer's own external site
// (`origineOffre.urlOrigine`, see ScrapingService), not at France Travail
// itself. This applier is only ever invoked for offers actually hosted on
// francetravail.fr (see AutoApplyService's matchesOwnDomain) — everything
// else routes straight to GenericApplier's best-effort form-filling instead.
@Injectable()
export class FranceTravailApplier implements JobApplier {
  readonly credentialPlatform = 'france_travail';
  private readonly logger = new Logger(FranceTravailApplier.name);

  constructor(
    private ai: AiService,
    private gmailOtp: GmailOtpService,
  ) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);
    // Reassigned, not `page` itself, once the genuinely-native flow below
    // (see the `#contactZone` branch) opens its real form in a new tab --
    // every check and fill from that point on needs to run against that new
    // tab instead of the original job-listing tab it came from.
    let activePage = page;

    const loginResult = await this.ensureLoggedIn(page, ctx);
    if (loginResult) return loginResult;

    const applyButton = page.getByRole('button', { name: /^postuler/i }).or(page.getByRole('link', { name: /^postuler/i })).first();
    const hasApplyButton = await applyButton.isVisible().catch(() => false);
    if (!hasApplyButton) {
      return {
        success: false,
        note: "Bouton de candidature France Travail introuvable sur cette offre — à traiter manuellement.",
      };
    }

    // On some offers "Postuler" is a dropdown toggle (aria-haspopup) rather
    // than a direct link — clicking it just reveals a menu with the real
    // action instead of navigating (confirmed live: id="detail-apply",
    // data-toggle="dropdown"). Click through to the actual item if so.
    const isDropdownToggle = (await applyButton.getAttribute('aria-haspopup').catch(() => null)) === 'true';
    // Confirmed live via a real crash trace: the `pe-cookies` banner isn't
    // necessarily there yet when dismissCookieBanner ran right after
    // navigation — it showed up later, intercepting this exact click after
    // ensureLoggedIn's own checks had already run. Same reasoning as the
    // Cegedim case elsewhere: cheap, harmless to call again immediately
    // before the click that's actually at risk of being blocked by it.
    await dismissCookieBanner(page);
    // Confirmed live AGAIN even with the above: the banner can reappear in
    // the narrow gap between that dismiss call and this exact click,
    // making the "when do we dismiss it" timing genuinely impossible to
    // pin down from outside. `force: true` sidesteps the whole problem —
    // it skips Playwright's "element actually receives pointer events"
    // actionability check (the literal reason every one of these crashes
    // fired: "<pe-cookies> intercepts pointer events"), while still
    // requiring the real target element to exist and be attached. The
    // banner is a decorative overlay with no functional purpose beyond
    // consent, not something that needs to visibly receive this click.
    await applyButton.click({ force: true }).catch(() => applyButton.click());
    // Confirmed live via a real debug trace: this "Postuler" toggle has
    // data-async-trigger="true" — its dropdown's actual content (a
    // "postuler" menu item, OR the "choisissez le partenaire" partner
    // picker checked further below) is fetched via AJAX after the click,
    // not present in the initial DOM. The isVisible() checks right after
    // this used to resolve near-instantly when nothing matched yet (their
    // own timeouts only bound how long they'll keep *polling*, not how
    // long they take to give up once Playwright decides nothing will ever
    // match), so the real wall-clock gap between this click and those
    // checks could end up far shorter than 800ms — not long enough for the
    // AJAX call to land. A real reproduction confirmed both branches
    // finding nothing (count=0) purely from this timing gap, on a job
    // whose partner-picker markup was independently confirmed correct.
    // Widened to give that request genuine room to complete.
    await page.waitForTimeout(2500);

    if (isDropdownToggle) {
      const menuItem = page
        .locator('.dropdown-menu:visible a, .dropdown-menu:visible button, [role="menu"]:visible a, [role="menu"]:visible button')
        .filter({ hasText: /postuler/i })
        .first();
      if (await menuItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await humanClick(page, menuItem).catch(() => menuItem.click({ timeout: 5000 }).catch(() => {}));
        await page.waitForTimeout(1200);
      }
    }

    // France Travail's OWN native apply form (`/candidature/postulerenligne/
    // <offerId>`) — its actual, genuinely-in-house flow -- is reached
    // through neither of the two branches above: confirmed live via a real,
    // human-recorded click-through, clicking "Postuler" instead reveals a
    // `#contactZone` panel containing a link accessibly named "Envoyer ma
    // candidature pour l'offre ... (nouvelle fenêtre)" -- "nouvelle fenêtre"
    // because it opens the real form in a NEW TAB, not the current one.
    // Every offer tested before that recording (PROPULSE IT, Collective.work,
    // SOPRA STERIA -> SmartRecruiters) happened to be an aggregator listing
    // that redirects off-platform, so this specific, genuinely-native path
    // had simply never been exercised until now. Unlike the partner-modal
    // and employer-redirect branches above, the destination here STAYS on
    // francetravail.fr -- so the new tab is followed and adopted as the
    // page every subsequent step runs against, instead of being treated as
    // an external hand-off.
    // Not only inside #contactZone any more: confirmed live (H&A DATA
    // SOLUTIONS offer) that "Postuler" now opens a "Rappel des critères
    // principaux avant de postuler" popover whose "Envoyer ma candidature"
    // button sits outside that zone -- the #contactZone-only locator never
    // saw it and the attempt idled on the listing page until its timeout.
    const nativeApplyLink = page
      .locator('#contactZone a, #contactZone button, a, button')
      .filter({ hasText: /envoyer ma candidature|postuler en ligne/i })
      .filter({ visible: true })
      .first();
    // Actively polls for up to 5s (matching the analogous `menuItem` check
    // just above) rather than a single instant check right after the fixed
    // 2500ms sleep above -- confirmed live that the fixed sleep alone was
    // occasionally NOT quite enough under the real stealth/fingerprint/
    // route-blocking overhead this runs with in production (an isolated
    // repro without any of that overhead found the link reliably), leaving
    // the applier stuck operating on the original job-listing page instead
    // of the real form.
    let nativeLinkVisible = await nativeApplyLink.isVisible({ timeout: 5000 }).catch(() => false);
    // Confirmed live AGAIN: even the 5s poll above intermittently missed it
    // under the real orchestrator's load (concurrent AI calls, screencast,
    // shared browser process) on an offer independently confirmed, moments
    // apart via an isolated check, to render this exact link reliably --
    // a one-shot re-click gives the async-loaded panel (see the isDropdownToggle
    // comment above -- `data-async-trigger="true"`) a second chance to land
    // rather than falling through to the job-listing page's own unrelated
    // widgets and misreporting one of THEIR fields as a blocking question.
    // Confirmed live via a real diagnostic capture: on a Collective.work/
    // XTRAMILE offer, this retry click was firing WHILE the "Choisissez le
    // partenaire" panel from the original click was already open --
    // re-clicking the same toggle button closed it (a normal dropdown
    // open/close-on-click pattern), and by the time the partner-panel check
    // further below ran, its own element count was still 1 but no longer
    // visible. Skipping the retry click whenever that panel is already
    // open avoids stepping on it -- there's nothing to retry for, this
    // was never going to be a native form once a partner picker has
    // already appeared.
    const partnerAlreadyOpen = await page
      .getByText(/choisissez le partenaire|postuler sur le site du recruteur/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (!nativeLinkVisible && !partnerAlreadyOpen) {
      await applyButton.click({ force: true }).catch(() => applyButton.click().catch(() => {}));
      await page.waitForTimeout(2000);
      nativeLinkVisible = await nativeApplyLink.isVisible({ timeout: 5000 }).catch(() => false);
    }
    if (nativeLinkVisible) {
      await ctx.appendLog?.('Ouverture du formulaire natif France Travail (nouvel onglet)...');
      const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
      await nativeApplyLink.click().catch(() => {});
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        if (popup.url().includes('francetravail.fr')) {
          activePage = popup;
          await dismissCookieBanner(activePage);
          await ctx.appendLog?.(`Formulaire natif chargé : ${popup.url()}`);
        } else {
          const url = popup.url();
          await popup.close().catch(() => {});
          if (url) return { success: false, redirectToExternalUrl: url };
        }
      } else {
        await ctx.appendLog?.('Aucun nouvel onglet détecté après le clic — poursuite sur la page actuelle.');
        // No separate tab actually opened (e.g. `target` was stripped, or
        // the click navigated the current tab instead) -- if the CURRENT
        // page already moved to the native apply URL, there's nothing left
        // to adopt; `activePage` already points at it.
        await page.waitForTimeout(1500);
      }
    }

    // France Travail sometimes acts as an aggregator rather than hosting the
    // application itself: clicking "Postuler" can reveal a "Choisissez le
    // partenaire" panel offering one or more external ATS partners (confirmed
    // live: a single "XTRAMILE" card in a modal, AND separately a single
    // "PMEJOB" link inside the SAME dropdown menu the isDropdownToggle branch
    // above already opens) instead of a native form. That branch only ever
    // looks for a menu item literally reading "postuler" — a partner-picker
    // dropdown never has one (its links are named after the partner, e.g.
    // "PMEJOB"), so it silently falls through here every time, and this
    // check used to require a `[role="dialog"]`/`.modal`/`popin`/`popup`
    // container, none of which a plain `.dropdown-menu` ever matches either.
    // Confirmed live via a real form snapshot: with neither branch ever
    // firing, the applier ran fillIdentityFields/runFormLoop against the
    // original job page with the dropdown still open over it — no real form
    // ever existed there, so every AI call saw the same near-empty snapshot
    // and produced the same stuck non-answer every single time. Mirrors the
    // Welcome to the Jungle resolution pattern (see
    // resolveWelcomeToTheJungleApplyUrl) -- follow the partner link out to
    // its real URL and hand off to whichever applier owns it, instead of
    // ever reaching the AI loop for a step this applier could never have
    // filled in anyway.
    // Confirmed live AGAIN on a SOPRA STERIA offer: this same dropdown can
    // instead read "Postuler sur le site du recruteur" with a single link
    // named after the employer itself (not a generic ATS partner) — a third
    // phrasing neither "choisissez le partenaire" nor a literal "postuler"
    // menu item matches. With no branch recognizing it, the applier fell
    // through onto the job-description page (dropdown still open over it,
    // no real form anywhere on it) and scanInvalidFields picked up an
    // unrelated "Destinataire" field from a "share by email" widget
    // elsewhere on the page, reporting it as a blocking question that was
    // never actually part of any application form.
    // Confirmed live YET AGAIN on a Collective.work/XTRAMILE offer: this
    // exact panel ("Choisissez le partenaire :" with a single XTRAMILE
    // card) sat there fully visible for the entire 120s of an attempt that
    // ended in an orchestrator-level timeout -- the container selector
    // below (dropdown-menu/modal/popin/popup/role=dialog) matched none of
    // it, so this whole check never fired and the AI loop was left
    // grinding on a page with no real form on it every single step. Three
    // prior "confirmed live" notes above already document this same
    // guessing game for THREE earlier markup variants. Anchoring on the
    // heading's own TEXT instead of its wrapping container's class/role
    // sidesteps needing to guess that container's markup ever again --
    // `following::a|button` walks forward in DOM order from the heading to
    // the nearest actual link/button regardless of what wraps either one.
    const partnerHeading = activePage
      .getByText(/choisissez le partenaire|postuler sur le site du recruteur/i)
      .first();
    if (await partnerHeading.isVisible().catch(() => false)) {
      await ctx.appendLog?.('Cette offre France Travail redirige vers un partenaire externe...');
      const partnerLink = partnerHeading
        .locator('xpath=following::a[1] | following::button[1]')
        .filter({ hasNotText: /fermer|close|annuler/i })
        .first();
      if (await partnerLink.isVisible().catch(() => false)) {
        const externalUrl = await resolveExternalApplyUrl(activePage, partnerLink, /francetravail\.fr/i);
        if (externalUrl) {
          return { success: false, redirectToExternalUrl: externalUrl };
        }
      }
      return {
        success: false,
        note: 'Cette offre France Travail redirige vers un partenaire externe (ex: XTRAMILE) — à traiter manuellement.',
      };
    }

    // Not every external-redirect case shows the partner modal above -- some
    // just navigate away immediately after the click, or show plain inline
    // text with no separate link to follow. If the URL already left
    // francetravail.fr by this point, report the real destination instead of
    // a generic "traiter manuellement" note with no actionable link.
    const externalRedirectNotice = await activePage
      .getByText(/site de l'employeur|candidature externe|vous allez être redirigé/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (externalRedirectNotice || !activePage.url().includes('francetravail.fr')) {
      if (!activePage.url().includes('francetravail.fr')) {
        return { success: false, redirectToExternalUrl: activePage.url() };
      }
      return {
        success: false,
        note: "Cette offre France Travail redirige vers le site de l'employeur — à traiter manuellement.",
      };
    }

    // The native `postulerenligne` form (reached via the `#contactZone`
    // branch above) has its own specific widgets a generic identity-field
    // scan was never going to recognize -- confirmed live via the same
    // human recording: a list of the candidate's own already-uploaded CVs
    // to pick from (`[id^="cv-"]`, not a file input -- `uploadCv` below
    // only ever handles the latter), a "carte de visite" pitch/profile
    // blurb to pick (`[id^="choix-carte-visite-"]`), and a required
    // "j'confirme que mes coordonnées sont valides" consent checkbox
    // (`#confirmcoordonnees`). Best-effort: pick the first (often only)
    // option Playwright finds for the first two, matching what a candidate
    // with a single CV/pitch on file would click anyway; skip silently if
    // none exist; on either, no consequence if empty.
    const cvOption = activePage.locator('[id^="cv-"]').first();
    const pickedExistingCv = await cvOption.isVisible().catch(() => false);
    if (pickedExistingCv) {
      await cvOption.click().catch(() => {});
    }
    const carteVisiteOption = activePage.locator('[id^="choix-carte-visite-"]').first();
    if (await carteVisiteOption.isVisible().catch(() => false)) {
      await carteVisiteOption.click().catch(() => {});
    }

    await fillIdentityFields(activePage, ctx.cv);

    // Confirmed live: uploading a brand-new CV via the generic file input
    // WHILE an existing CV was already picked above leaves the form in a
    // half-finished state (the upload opens its own separate "nommez ce
    // fichier" confirmation step, never resolved) and led straight to
    // France Travail's own "Une erreur technique a eu lieu et votre
    // candidature n'a pu aboutir" on submit -- the two are mutually
    // exclusive actions on this form, not a fill-everything-you-can-find
    // situation like every other applier's identity/file fields. Only
    // falls back to a fresh upload when there was no existing CV to pick.
    if (!pickedExistingCv) {
      // `count()`, not `isVisible()` — confirmed live that Playwright's
      // setInputFiles works on a hidden input, same issue found and fixed
      // across every applier here.
      const fileInput = await findCvFileInput(activePage);
      if (fileInput) {
        await uploadCv(fileInput, ctx).catch(() => {});
      }
    }

    const consentCheckbox = activePage.locator('#confirmcoordonnees').first();
    if (await consentCheckbox.isVisible().catch(() => false)) {
      await consentCheckbox.check().catch(() => {});
    }

    // Confirmed live via a real submitted candidature (DATAMED RESEARCH,
    // offer 213XKDH): the "lettre de motivation" field arrives pre-filled
    // with France Travail's OWN generic boilerplate ("Je me permets de vous
    // solliciter pour le poste de ..."), set client-side by the Angular
    // form some time after the page's own initial load/render -- a fill()
    // called too early (right after fillIdentityFields, as this used to be
    // ordered) got silently reverted back to that boilerplate by the time
    // the form was actually submitted, so a fully-configured AI cover
    // letter never reached the real employer even though the fill call
    // itself reported no error. Filling as the LAST action before submit
    // (right here) and re-asserting once after a short wait closes that
    // race instead of trusting a single early fill to survive it.
    if (ctx.coverLetter) {
      const coverLetterField = activePage
        .locator('textarea[id*="lettre" i], textarea[aria-label*="lettre" i], textarea[name*="message" i]')
        .first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        // France Travail's own cap ("* Saisissez votre lettre de motivation
        // (obligatoire) 1500 caractères maximum") -- an AI-generated cover
        // letter meant for a full-page PDF/email is almost always longer.
        // Truncated here rather than relying on the field's own maxlength
        // to silently clip it, so the fill always lands a complete
        // sentence rather than a mid-word cut.
        // No "…" appended any more: that U+2026 was the ONLY character
        // outside Latin-1 in the whole submission, and three consecutive
        // native submissions with a >1500-char letter all ended in France
        // Travail's "Une erreur technique a eu lieu" (confirmed by the
        // pre-submit form dump), while the one known success had a short
        // letter. Cut at a sentence boundary instead.
        const trimmed = truncateAtBoundary(ctx.coverLetter, 1500);
        await coverLetterField.fill(trimmed).catch(() => {});
        await activePage.waitForTimeout(800);
        const current = await coverLetterField.inputValue().catch(() => trimmed);
        if (current !== trimmed) {
          await coverLetterField.fill(trimmed).catch(() => {});
        }
      }
    }

    const loopResult = await runFormLoop(activePage, ctx, this.ai, {
      // Confirmed live: the native form's real submit button is simply
      // named "Envoyer" -- no "candidature" suffix -- which the previous
      // pattern never matched, so a fully-completed native form would have
      // sat there unsubmitted until the AI fallback (or the step budget)
      // eventually gave up on it.
      submitText: /^envoyer$|envoyer( ma)? candidature|valider ma candidature/i,
      nextText: /suivant|continuer/i,
      successText:
        /candidature (a (bien )?été (envoyée|transmise|enregistrée|prise en compte)|envoyée|transmise)|confirmation de candidature|candidature enregistrée/i,
      successUrl: /candidature\/confirmation|postulerenligne\/confirmation|confirmation|merci/i,
      blockedNote: 'Le formulaire de candidature France Travail contient un champ non renseigné — à finaliser manuellement.',
      unresolvedNote: 'Soumission France Travail envoyée mais confirmation non détectée — à vérifier manuellement.',
    });

    // Confirmed live on the attempts' own screenshots: 10 real "confirmation
    // non détectée" results were nothing of the sort -- France Travail had
    // put its own red banner on the page ("Une erreur technique a eu lieu et
    // votre candidature n'a pu aboutir, merci de réessayer ultérieurement")
    // and the submission had NOT gone through. Reporting that as "couldn't
    // confirm" threw away the one piece of information on the page and left
    // it indistinguishable from a submission that genuinely succeeded with
    // unmatched wording. It's a platform-side rejection, and France Travail
    // itself says to retry later, so it's named as exactly that.
    let result = loopResult;
    if (!loopResult.success) {
      const bodyText = await activePage.locator('body').innerText({ timeout: 3000 }).catch(() => '');
      if (/une erreur technique a eu lieu|candidature n.a pu aboutir/i.test(bodyText)) {
        result = {
          ...loopResult,
          note: "France Travail a rejeté l'envoi avec une erreur technique de son côté (« votre candidature n'a pu aboutir, merci de réessayer ultérieurement ») — la candidature n'est pas partie, à relancer plus tard.",
        };
      }
    }
    // See ApplyResult.finalPage -- only actually differs from `page` once
    // the `#contactZone` branch above adopted a new tab.
    return activePage === page ? result : { ...result, finalPage: activePage };
  }

  private async ensureLoggedIn(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.france_travail.isLoginWallVisible(page);
    if (!onLoginWall) return null; // already have a valid, reused session

    // Attempt automatic background re-login if credentials are stored
    if (
      ctx.credential?.email &&
      ctx.credential?.password &&
      ctx.credential.email !== '(session importée)' &&
      ctx.credential.email !== '(connecté via navigateur intégré)'
    ) {
      await ctx.appendLog?.(`Session expirée — reconnexion automatique France Travail avec ${ctx.credential.email}...`);
      try {
        await page.goto(REMOTE_LOGIN_URLS.france_travail, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const idField = page.locator('#identifiant, input[name="identifiant"]').first();
        await idField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        await dismissCookieBanner(page).catch(() => {});

        if (await idField.isVisible().catch(() => false)) {
          await idField.fill(ctx.credential.email);
          const passField = page.locator('#password, input[name="password"], input[type="password"]').first();
          if (await passField.isVisible().catch(() => false)) {
            await passField.fill(ctx.credential.password);
          }
          const loginBtn = page.locator('#submit, #boutonConnexion, #boutonSeConnecter, button:has-text("Se connecter"), button[type="submit"]').first();
          if (await loginBtn.isVisible().catch(() => false)) {
            await loginBtn.click({ force: true }).catch(() => loginBtn.click());
          } else {
            await idField.press('Enter');
          }
          await page.waitForTimeout(5000);
        }

        // Automatic email 2FA / OTP validation via Gmail
        await ctx.appendLog?.('Vérification 2FA / OTP — recherche de canal e-mail et relevé Gmail...');
        await handleUniversalEmailOtp(page, 'france_travail', ctx.userId, this.gmailOtp, {
          log: (m) => ctx.appendLog?.(m),
          warn: (m) => ctx.appendLog?.(`⚠️ ${m}`),
        });

        const stillOnWall = await SESSION_CHECKS.france_travail.isLoginWallVisible(page);
        if (!stillOnWall) {
          await ctx.appendLog?.('Reconnexion automatique France Travail réussie !');
          const state = await page.context().storageState().catch(() => null);
          if (state) {
            await ctx.onSessionUpdated?.(JSON.stringify(state));
          }
          await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await dismissCookieBanner(page).catch(() => {});
          return null;
        }
      } catch (err: any) {
        this.logger.warn(`Auto-relogin France Travail error: ${err.message}`);
      }
    }

    return {
      success: false,
      sessionExpired: true,
      note: "Session France Travail absente ou expirée — ouvrez Comptes dans Paramètres pour vous connecter via le navigateur intégré.",
    };
  }
}
