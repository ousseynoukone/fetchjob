import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import {
  dismissCookieBanner,
  humanClick,
  humanFill,
  hasSecurityCheck,
  trySolveSlideChallenge,
  findCvFileInput,
  uploadCv,
  truncateAtBoundary,
} from './ats-common';

// Every selector and the two-click sequence below are transcribed directly
// from a real, user-recorded application on free-work.com (a Chrome
// DevTools Recorder export): the offer needs NO account at all — clicking
// "Postuler" reveals an optional message box and a CV picker; only once a
// CV is attached does the SAME "Postuler" button turn into the real submit
// step ("Je postule"). Confirmed in that recording: no login screen
// anywhere in the flow. This applier used to be short-circuited as
// "compte requis" by the generic applier's ACCOUNT_ONLY_BOARDS list --
// that was wrong, based on an earlier reading of a page that must have
// been showing something else (a saved-search/alert prompt, not the apply
// flow itself).
@Injectable()
export class FreeWorkApplier implements JobApplier {
  // Not null: a stored email/password is used as a fallback ONLY if a
  // login/signup wall unexpectedly appears on some offer (the recording
  // itself never hits one) -- see ensureNotLoginWalled below.
  readonly credentialPlatform = 'free_work';
  private readonly logger = new Logger(FreeWorkApplier.name);

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    if (await hasSecurityCheck(page)) {
      const solved = await trySolveSlideChallenge(page);
      if (!solved) {
        return { success: false, note: 'Vérification de sécurité affichée par Free-Work — à finaliser manuellement.' };
      }
      await page.waitForTimeout(2000);
    }

    const postulerBtn = page.getByRole('button', { name: /^postuler$/i }).first();
    if (!(await postulerBtn.isVisible({ timeout: 8000 }).catch(() => false))) {
      return { success: false, note: "Bouton « Postuler » introuvable sur cette offre Free-Work — à traiter manuellement." };
    }
    await humanClick(page, postulerBtn).catch(() => postulerBtn.click().catch(() => {}));
    await page.waitForTimeout(1500);

    const loginWallNote = await this.ensureNotLoginWalled(page, ctx);
    if (loginWallNote) return loginWallNote;

    // Confirmed live on a LOGGED-IN account: clicking "Postuler" on an
    // offer this account already applied to (e.g. a prior run's submit DID
    // go through even though its confirmation wasn't recognized at the
    // time) shows "Vous avez postulé à cette offre le <date>" instead of
    // the message/CV panel -- read as a genuine, idempotent success rather
    // than "form didn't open as expected". Checked via body.innerText (not
    // getByText) and actually re-polled a few times: confirmed live that a
    // single immediate read landed before the panel had swapped in, even
    // though the text was on the page a moment later.
    const alreadyApplied = await this.hasAlreadyAppliedText(page);
    if (alreadyApplied) {
      await ctx.appendLog?.('Free-Work indique une candidature déjà envoyée pour cette offre — traité comme un succès.');
      return { success: true, note: 'Candidature déjà envoyée sur Free-Work (détecté au ré-essai).' };
    }

    // Confirmed live: not every free-work.com posting uses the recorded,
    // account-less flow -- an agency/partner-branded listing (e.g. a
    // FreelanceRepublik posting) instead shows a dark "Postulez à cette
    // offre !" block with "Créer un compte" / "Se connecter", and neither
    // the message box nor the resume-edit control this applier expects
    // ever appears. Told apart here rather than pressing on and reporting
    // a confusing "no CV field found".
    let messageOrResumeAppeared = await page
      .locator('#job-application-message, #default-resume-edit')
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (!messageOrResumeAppeared) {
      const seConnecterBtn = page.getByRole('button', { name: /se connecter/i }).first();
      const hasSignupBlock =
        (await page.getByRole('button', { name: /cr[ée]er un compte/i }).first().isVisible().catch(() => false)) &&
        (await seConnecterBtn.isVisible().catch(() => false));
      if (hasSignupBlock) {
        // Confirmed live: three separate offers all landed here (an
        // agency/partner-branded listing) rather than the account-less
        // recorded flow -- with a real stored credential, worth actually
        // logging in instead of giving up immediately.
        if (!ctx.credential?.email || !ctx.credential?.password) {
          return {
            success: false,
            note: 'Cette offre Free-Work (partenaire/agence) exige un compte pour postuler — candidature à effectuer directement sur le lien de l’offre.',
          };
        }
        await ctx.appendLog?.('Offre Free-Work partenaire — connexion avec le compte enregistré...');
        await humanClick(page, seConnecterBtn).catch(() => seConnecterBtn.click().catch(() => {}));
        await page.waitForTimeout(1500);
        const loginFailedNote = await this.ensureNotLoginWalled(page, ctx);
        if (loginFailedNote) return loginFailedNote;
        // Re-click Postuler now that the session is authenticated -- the
        // apply panel that failed to open before should behave exactly
        // like the recorded, account-less flow from here on.
        const postulerAfterLogin = page.getByRole('button', { name: /^postuler$/i }).first();
        if (await postulerAfterLogin.isVisible({ timeout: 5000 }).catch(() => false)) {
          await humanClick(page, postulerAfterLogin).catch(() => postulerAfterLogin.click().catch(() => {}));
          await page.waitForTimeout(1500);
        }
        messageOrResumeAppeared = await page
          .locator('#job-application-message, #default-resume-edit')
          .first()
          .isVisible({ timeout: 5000 })
          .catch(() => false);
      }
    }
    if (!messageOrResumeAppeared) {
      return {
        success: false,
        note: "Le formulaire de candidature Free-Work ne s'est pas ouvert comme attendu — à vérifier manuellement.",
      };
    }

    // Optional message — confirmed in the recording as a free-text box the
    // real user left empty; only filled here if a cover letter exists, and
    // capped generously since the site gives no visible character limit to
    // read from.
    const messageField = page.locator('#job-application-message').first();
    if (ctx.coverLetter && (await messageField.isVisible().catch(() => false))) {
      await humanFill(messageField, truncateAtBoundary(ctx.coverLetter, 2000)).catch(() => {});
    }

    // CV: the recording's "Modifier"/edit-resume control opens a modal
    // containing the real file input (`data-testid="file-upload-input"`),
    // then a separate "Envoyer mon CV" button actually attaches it —
    // uploading and submitting are two distinct actions here, unlike every
    // other applier in this file.
    const editResumeBtn = page.locator('#default-resume-edit').first();
    if (await editResumeBtn.isVisible().catch(() => false)) {
      await humanClick(page, editResumeBtn).catch(() => editResumeBtn.click().catch(() => {}));
      await page.waitForTimeout(800);
    }

    const cvInput =
      (await page.locator('[data-testid="file-upload-input"] input[type="file"]').first().count().catch(() => 0)) > 0
        ? page.locator('[data-testid="file-upload-input"] input[type="file"]').first()
        : await findCvFileInput(page);

    if (cvInput) {
      await uploadCv(cvInput, ctx).catch(() => {});
      await page.waitForTimeout(500);
      const sendCvBtn = page.getByRole('button', { name: /envoyer mon cv/i }).first();
      if (await sendCvBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await humanClick(page, sendCvBtn).catch(() => sendCvBtn.click().catch(() => {}));
        await page.waitForTimeout(1500);
      } else {
        // Confirmed live on a LOGGED-IN account: instead of the recorded
        // anonymous flow's single upload modal, a signed-in profile with
        // saved CVs already on file gets a "Mes documents" library modal
        // (heading "Mes documents", action button "Partager le CV") --
        // the just-uploaded file shows up there as a new entry rather than
        // being sent by an "Envoyer mon CV" button, which doesn't exist in
        // this variant.
        const shareCvBtn = page.getByRole('button', { name: /partager le cv/i }).first();
        if (await shareCvBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await humanClick(page, shareCvBtn).catch(() => shareCvBtn.click().catch(() => {}));
          await page.waitForTimeout(1500);
        }
      }
      // Close whatever dialog is still open (the recording's own next step
      // on the anonymous flow is a click on its header icon; the logged-in
      // "Mes documents" variant needs the same, on a differently-scoped
      // container) -- broad, role-based selector rather than one tied to a
      // single modal's data-testid so both variants are covered, harmless
      // no-op if it already closed itself.
      const closeModalBtn = page
        .locator('[data-testid="file-chooser-modal"] svg, [role="dialog"] svg, [role="dialog"] button[aria-label*="fermer" i], [role="dialog"] button[aria-label*="close" i], button[aria-label*="fermer" i], button[aria-label*="close" i]')
        .filter({ visible: true })
        .first();
      if (await closeModalBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await humanClick(page, closeModalBtn).catch(() => closeModalBtn.click().catch(() => {}));
        await page.waitForTimeout(500);
      }
      // Never proceed with a dialog still covering the page -- confirmed
      // live that the next two clicks (Postuler again, Je postule) either
      // silently miss their real target or hit something inside a
      // still-open "Mes documents" modal instead when this isn't checked.
      const stillOpen = await page.locator('[role="dialog"]').filter({ visible: true }).first().isVisible({ timeout: 1000 }).catch(() => false);
      if (stillOpen) {
        await ctx.appendLog?.('Une fenêtre Free-Work (gestion des CV) est restée ouverte — nouvelle tentative de fermeture...');
        const anyCloseIcon = page.locator('[role="dialog"] button, [role="dialog"] [role="button"]').filter({ visible: true }).first();
        if (await anyCloseIcon.isVisible().catch(() => false)) {
          await humanClick(page, anyCloseIcon).catch(() => anyCloseIcon.click().catch(() => {}));
          await page.waitForTimeout(800);
        }
      }
    } else {
      await ctx.appendLog?.('Aucun champ de dépôt de CV trouvé sur Free-Work — poursuite sans CV joint.');
    }

    // Second click: confirmed in the recording -- with the CV now
    // attached, the SAME "Postuler" button (still in the aside) advances
    // to the real submit step instead of re-opening the same panel.
    const postulerAgainBtn = page.getByRole('button', { name: /^postuler$/i }).first();
    if (await postulerAgainBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await humanClick(page, postulerAgainBtn).catch(() => postulerAgainBtn.click().catch(() => {}));
      await page.waitForTimeout(1500);
    }

    const submitBtn = page.getByRole('button', { name: /je postule/i }).first();
    if (!(await submitBtn.isVisible({ timeout: 8000 }).catch(() => false))) {
      return {
        success: false,
        note: "Le formulaire Free-Work n'a pas atteint l'étape finale (« Je postule » introuvable) — à vérifier manuellement.",
      };
    }
    await ctx.appendLog?.('Envoi de la candidature Free-Work...');
    await humanClick(page, submitBtn).catch(() => submitBtn.click().catch(() => {}));
    await page.waitForTimeout(1000);

    // Confirmed live: when the candidate's declared status (e.g. "Worker")
    // doesn't match what the offer asked for (e.g. "Freelance"), clicking
    // "Je postule" opens a "Vérifiez votre statut (avant de postuler)"
    // dialog instead of submitting -- it only warns the recruiter will see
    // the mismatch, it doesn't block the application outright, so the
    // existing match-scoring step already decided this offer was worth
    // applying to. Confirmed here, not skipped.
    const statusMismatchBtn = page.getByRole('button', { name: /confirmer candidature/i }).first();
    if (await statusMismatchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await ctx.appendLog?.('Free-Work signale un statut candidat différent de celui demandé par l’offre — confirmation de la candidature malgré tout.');
      await humanClick(page, statusMismatchBtn).catch(() => statusMismatchBtn.click().catch(() => {}));
      await page.waitForTimeout(1000);
    }

    // Confirmed in the recording (anonymous flow): success shows as a toast
    // (`fw-toast p.text-sm`) rather than a page navigation or inline text.
    // Confirmed live on a LOGGED-IN account: that exact toast never showed
    // up even though the CV was genuinely attached and the click landed on
    // a real, visible "Je postule" button -- broadened to any toast-like
    // region instead of trusting one tag that only ever covered the
    // anonymous variant.
    const toast = page.locator('fw-toast, [role="status"], [role="alert"], [class*="toast" i]').first();
    const toastAppeared = await toast.isVisible({ timeout: 8000 }).catch(() => false);
    if (!toastAppeared) {
      // Confirmed live on a LOGGED-IN account: no toast of any kind ever
      // appeared even on a genuinely successful submit -- that variant's
      // real confirmation is the CV panel being replaced by "Vous avez
      // postulé à cette offre le <date>" (the same text alreadyApplied
      // checks for on re-entry). Checked here before giving up.
      const confirmedByText = await this.hasAlreadyAppliedText(page);
      if (confirmedByText) {
        await ctx.appendLog?.('Candidature Free-Work confirmée (« Vous avez postulé à cette offre »).');
        return { success: true };
      }
      // No confirmed positive signal for this variant yet -- capture real
      // page state into the run log instead of only a screenshot, so the
      // next diagnosis pass doesn't need another manual screenshot pull.
      const submitStillVisible = await submitBtn.isVisible({ timeout: 2000 }).catch(() => false);
      const bodyText = await page.locator('body').innerText().catch(() => '');
      await ctx.appendLog?.(
        `Aucun toast Free-Work détecté après clic sur « Je postule » (bouton encore visible : ${submitStillVisible}) — extrait de la page : ${bodyText.replace(/\s+/g, ' ').slice(0, 400)}`,
      );
      return { success: false, note: 'Formulaire Free-Work soumis mais confirmation non détectée — à vérifier manuellement.' };
    }
    const toastText = await toast.innerText().catch(() => '');
    if (/erreur|échec|invalid|obligatoire/i.test(toastText)) {
      return { success: false, note: `Free-Work a rejeté l'envoi : « ${toastText.trim().slice(0, 150)} » — à vérifier manuellement.` };
    }
    await ctx.appendLog?.(`Candidature Free-Work confirmée : ${toastText.trim().slice(0, 150) || '(toast affiché)'}`);
    return { success: true };
  }

  // Polls body.innerText (which, unlike textContent/getByText matches,
  // naturally excludes anything hidden by CSS -- no risk of landing on an
  // off-screen responsive duplicate) a few times rather than reading once:
  // confirmed live that a single immediate read fired before this panel had
  // actually swapped in, even though the text was there half a second later.
  private async hasAlreadyAppliedText(page: Page): Promise<boolean> {
    for (let i = 0; i < 5; i++) {
      const text = await page.locator('body').innerText().catch(() => '');
      if (/vous avez postul[ée] [àa] cette offre/i.test(text)) return true;
      await page.waitForTimeout(800);
    }
    return false;
  }

  // The recording never hits this — kept as a fallback in case a specific
  // offer (or a returning visitor's cookie state) does show a login wall,
  // using the credential the user supplied directly for this platform.
  private async ensureNotLoginWalled(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    const passwordField = page.locator('input[type="password"]:visible').first();
    if (!(await passwordField.isVisible().catch(() => false))) return null;

    if (!ctx.credential?.email || !ctx.credential?.password) {
      return {
        success: false,
        sessionExpired: true,
        note: 'Free-Work demande une connexion sur cette offre et aucun identifiant Free-Work n’est enregistré — ouvrez la page Comptes pour en ajouter un.',
      };
    }

    this.logger.log('Free-Work login wall encountered — attempting inline sign-in.');
    const emailField = page.locator('input[type="email"], input[name*="email" i]').first();
    if (await emailField.isVisible().catch(() => false)) {
      await humanFill(emailField, ctx.credential.email).catch(() => {});
    }
    await humanFill(passwordField, ctx.credential.password).catch(() => {});
    const loginBtn = page.getByRole('button', { name: /^se connecter$/i }).first();
    if (await loginBtn.isVisible().catch(() => false)) {
      await humanClick(page, loginBtn).catch(() => loginBtn.click().catch(() => {}));
    }

    // Confirmed live: a fixed 2s wait fired before the login POST +
    // redirect had actually resolved, reading the still-open modal (fields
    // correctly filled, real credential) as a rejection. Poll instead.
    let stillWalled = true;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      stillWalled = await page.locator('input[type="password"]:visible').first().isVisible().catch(() => false);
      if (!stillWalled) break;
    }
    if (stillWalled) {
      const errorText = await page
        .locator('[class*="error" i], [role="alert"], .text-red-500, .text-danger')
        .first()
        .innerText({ timeout: 1000 })
        .catch(() => '');
      await ctx.appendLog?.(`Connexion Free-Work toujours bloquée après 10s${errorText ? ` — message : ${errorText.trim().slice(0, 150)}` : ' — aucun message d\'erreur visible'}.`);
      return {
        success: false,
        sessionExpired: true,
        note: 'La connexion Free-Work a échoué (identifiants refusés ou vérification supplémentaire demandée) — à vérifier manuellement.',
      };
    }
    return null;
  }
}
