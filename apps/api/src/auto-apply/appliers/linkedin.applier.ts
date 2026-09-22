import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl, hasJobClosedIndicator, fillIdentityFields, uploadCv, normalizeLinkedInUrl, findCvFileInput, humanClick } from './ats-common';
import { buildFormSnapshot, applyFormPlan, formatFieldsForPrompt, formatButtonsForPrompt, buildCandidateBrief } from './ai-form-snapshot';
import { detectFormSuccess } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

// Confirmed live (probe with a real session, September 2026): LinkedIn's
// current Easy Apply modal is a native <dialog data-testid="dialog"> under
// a React #root, with hashed class names, a HEADER#dialog-header and NO
// role="dialog" / .artdeco-modal / .jobs-easy-apply-modal at all. The old
// selectors never matched it, so a fully rendered "Postuler chez ..." form
// read as "modal not shown"; the retry click then landed outside the
// dialog and popped LinkedIn's "Enregistrer cette candidature ?" prompt.
// Both generations are matched.
const EASY_APPLY_MODAL_SELECTOR =
  'dialog[data-testid="dialog"]:visible, dialog[open]:visible, .jobs-easy-apply-modal:visible, [role="dialog"]:visible, .artdeco-modal:visible';

const EASY_APPLY_SUCCESS_TEXT = /application sent|candidature envoy[eé]e|votre candidature a [eé]t[eé] envoy[eé]e/i;

function formatFrenchPhone(raw: string): string {
  if (!raw) return '';
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+33')) {
    const rest = cleaned.slice(3);
    return rest.startsWith('0') ? rest : '0' + rest;
  }
  if (cleaned.startsWith('0033')) {
    const rest = cleaned.slice(4);
    return rest.startsWith('0') ? rest : '0' + rest;
  }
  return cleaned;
}

@Injectable()
export class LinkedInApplier implements JobApplier {
  readonly credentialPlatform = 'linkedin';
  private readonly logger = new Logger(LinkedInApplier.name);

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await ctx.appendLog?.(`Navigation vers l'offre LinkedIn : ${ctx.application.jobTitle}...`);
    const targetUrl = normalizeLinkedInUrl(ctx.application.sourceUrl);
    try {
      await this.gotoWithRateLimitRetry(page, ctx, targetUrl);
    } catch (err: any) {
      if (err.message && err.message.includes('ERR_TOO_MANY_REDIRECTS')) {
        await ctx.appendLog?.('Session LinkedIn expirée ou invalide (boucle de redirection détectée).');
        return {
          success: false,
          sessionExpired: true,
          note: "Session LinkedIn expirée — ouvrez la page Comptes dans FindUrJob et cliquez sur \"Ouvrir la session\" pour LinkedIn afin de vous reconnecter.",
        };
      } else {
        throw err;
      }
    }
        await dismissCookieBanner(page);
    await this.handleConsentWall(page, ctx);

    await page.waitForTimeout(2000);

    const hasRenderedContent = async () =>
      page.locator('body').innerText({ timeout: 2000 }).then((t) => t.trim().length > 200).catch(() => false);

    if (!(await hasRenderedContent())) {
      await page.waitForTimeout(3000);
    }
    if (!(await hasRenderedContent())) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    const topCard = page.locator(
      '.jobs-unified-top-card, ' +
      '.job-details-jobs-unified-top-card__container--two-pane, ' +
      '[class*="jobs-unified-top-card" i], ' +
      '.top-card-layout, ' +
      '.jobs-details__main-content, ' +
      '.job-view-layout'
    ).first();
    const topCardScope = (await topCard.count().catch(() => 0)) > 0 ? topCard : page.locator('main, #main-content, body').first();

    // Check for Easy Apply specifically:
    // It is a button with Easy Apply / Candidature simplifiée text, or an a tag with /apply/
    // Exclude similar jobs, search-results, and collection links!
    const easyApplyButton = topCardScope
      .locator(
        'button.jobs-apply-button, ' +
        'button:has-text("Candidature simplifiée"), ' +
        'button:has-text("Easy Apply"), ' +
        'a[href*="/apply/"]:not([href*="search-results"]):not([href*="collections"])'
      )
      .first();

    // Check for external apply button (employer ATS, Free-Work, etc.)
    const externalApplyButton = topCardScope
      .locator(
        'button:has-text("Postuler"), button:has-text("Apply"), ' +
        'a:has-text("Postuler"), a:has-text("Apply"), ' +
        'a[data-tracking-control-name*="apply" i], button[data-tracking-control-name*="apply" i], ' +
        'a[href*="/safety/go/"]'
      )
      .filter({ hasNotText: /candidature simplifi|easy apply/i })
      .first();

    const hasEasyApply = (await easyApplyButton.count().catch(() => 0)) > 0 && (await easyApplyButton.isVisible().catch(() => false));

    if (!hasEasyApply) {
      if (await externalApplyButton.isVisible().catch(() => false)) {
        await ctx.appendLog?.('Redirection vers le site employeur...');
        const externalUrl = await resolveExternalApplyUrl(page, externalApplyButton, /linkedin\.com/i);
        if (externalUrl) {
          return { success: false, redirectToExternalUrl: externalUrl };
        }
      }

      // If neither is visible, check if we're on a login wall before concluding
      const loginResult = await this.ensureLoggedIn(page, ctx);
      if (loginResult) return loginResult;

      if (await hasJobClosedIndicator(page)) {
        await ctx.appendLog?.('Cette offre LinkedIn n\'accepte plus de candidatures.');
        return {
          success: false,
          note: "Cette offre LinkedIn n'accepte plus de candidatures -- à retirer ou ignorer.",
        };
      }

      await ctx.appendLog?.('Aucun bouton de candidature trouvé sur cette offre LinkedIn.');
      return {
        success: false,
        note: 'Aucun bouton de candidature trouvé sur cette offre LinkedIn -- à traiter manuellement.',
      };
    }

    this.logger.log(`Found Easy Apply button for ${ctx.application.id}, clicking...`);
    await ctx.appendLog?.('Bouton Candidature simplifiée détecté, ouverture du modal...');

    // Simulate a real human mouse movement to the button before clicking.
    // A bare Playwright `.click()` dispatches a synthetic event that LinkedIn's
    // bot-detection recognises and intentionally refuses to render the Easy Apply
    // modal for. Moving the real CDP mouse cursor to the element's bounding box
    // centre first — the way a real person's hand on a trackpad does — is the
    // simplest fix: confirmed live (and noted in the user report) that the modal
    // consistently loads when a real user clicks but consistently times out when
    // the automation click is used.
    const clickViaRealMouse = async (btn: typeof easyApplyButton) => {
      try {
        const box = await btn.boundingBox();
        if (box) {
          // Move to a random spot near the centre — not dead-centre, which is
          // another trivial bot tell.
          const x = box.x + box.width * (0.4 + Math.random() * 0.2);
          const y = box.y + box.height * (0.4 + Math.random() * 0.2);
          await page.mouse.move(x - 80, y - 40); // approach from upper-left
          await page.waitForTimeout(80 + Math.random() * 120);
          await page.mouse.move(x, y, { steps: 8 }); // glide in
          await page.waitForTimeout(60 + Math.random() * 80);
          await page.mouse.click(x, y);
          return true;
        }
      } catch {
        // boundingBox failed (element off-screen, layout shift) — fall through
      }
      // Last-resort fallback
      await btn.click({ timeout: 5000 }).catch(() => btn.evaluate((el: any) => el.click()));
      return true;
    };

    await clickViaRealMouse(easyApplyButton);
    await page.waitForTimeout(2000);

    // If redirected to consent wall, handle it and return to job
    if (page.url().includes('connect-services')) {
      await this.handleConsentWall(page, ctx);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      const retryBtn = topCardScope
        .locator('a[href*="/apply/"], a:has-text("Candidature simplifiée"), button:has-text("Candidature simplifiée")')
        .first();
      if (await retryBtn.isVisible().catch(() => false)) {
        await clickViaRealMouse(retryBtn);
        await page.waitForTimeout(2000);
      }
    }

    await ctx.appendLog?.('Chargement du formulaire Easy Apply...');
    // `:visible` matters here -- LinkedIn pages carry other permanently-hidden
    // `[role="dialog"]` elements (confirmed live: the messaging overlay
    // bubble in the bottom-right corner is one). A bare `.first()` over
    // DOM order can land on one of those instead of the real Easy Apply
    // modal, so this waits forever on an element that will never show while
    // the actual form is already fully rendered right next to it.
    const modalDialog = page
      .locator(EASY_APPLY_MODAL_SELECTOR)
      .first();
    await modalDialog.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

    // Wait up to 35s for the modal to appear. If it hasn't shown after 5s,
    // retry the click once (LinkedIn sometimes silently eats the first click
    // when its own page JS is still initialising). The orchestrator-level
    // timeout already caps the entire attempt, so a generous wait here never
    // risks an infinite hang.
    let modalLoaded = false;
    let retryClickDone = false;
    for (let attempt = 0; attempt < 35; attempt++) {
      await page.waitForTimeout(1000);

      // `[role="progressbar"]` used to be in this selector too — confirmed
      // live that it also matches Easy Apply's own permanent step-completion
      // bar ("0%" at the top of the modal, visible for the entire multi-step
      // flow, not just while loading), which made hasSpinner stay true
      // forever. modalLoaded then never flips true, the 18s timeout always
      // fires, and the whole step loop below (identity fields, upload, cover
      // letter, submit) never runs at all — even though the form was fully
      // rendered and ready (confirmed: a captured screenshot from exactly
      // this failure showed a completely usable, pre-filled form). Scoped to
      // LinkedIn's own actual spinner classes only.
      const hasSpinner = await page
        .locator('.artdeco-loader, .artdeco-loader__bars')
        .first()
        .isVisible()
        .catch(() => false);

      // Deliberately NOT `page.evaluate(() => document.querySelectorAll(...))`
      // here -- confirmed live that it always found zero dialog candidates
      // even while a screenshot taken at the exact same moment showed a
      // fully rendered, usable modal. LinkedIn's Easy Apply modal is built
      // with web components and lives inside a shadow root; raw DOM
      // querySelectorAll does not pierce shadow roots, but Playwright's own
      // locator CSS engine does (same reason `hasSpinner` above, which was
      // always a `page.locator`, never had this problem). Using locators
      // throughout avoids the blind spot entirely.
      const visibleDialog = page
        .locator(EASY_APPLY_MODAL_SELECTOR)
        .first();
      const dialogVisible = await visibleDialog.isVisible().catch(() => false);
      // Count interactive elements OR any visible text content — some Easy Apply
      // steps only contain radio groups or dropdowns (no bare <input> or <button>
      // at the top level), which previously made inputCount=0 and kept
      // hasInteractive false even on a fully-rendered, usable form.
      const inputCount = dialogVisible
        ? await visibleDialog
            .locator('input:not([type=hidden]), textarea, select, button, [role="radio"], [role="combobox"], [role="listbox"]')
            .count()
            .catch(() => 0)
        : 0;
      const hasInteractive = dialogVisible && inputCount > 0;

      if (!hasSpinner && hasInteractive) {
        modalLoaded = true;
        break;
      }

      // If the modal hasn't appeared after ~5s, LinkedIn may have silently
      // swallowed the first click (its page JS sometimes isn't ready yet).
      // Re-click once via real mouse — same human-like approach as the
      // initial click.
      if (!retryClickDone && attempt === 4) {
        retryClickDone = true;
        await ctx.appendLog?.('Modal non apparu — nouvelle tentative de clic sur Candidature simplifiée...');
        const retryEasyApply = topCardScope
          .locator(
            'button.jobs-apply-button, ' +
            'button:has-text("Candidature simplifiée"), ' +
            'button:has-text("Easy Apply"), ' +
            'a[href*="/apply/"]:not([href*="search-results"]):not([href*="collections"])'
          )
          .first();
        if (await retryEasyApply.isVisible().catch(() => false)) {
          const box = await retryEasyApply.boundingBox().catch(() => null);
          if (box) {
            const x = box.x + box.width * (0.4 + Math.random() * 0.2);
            const y = box.y + box.height * (0.4 + Math.random() * 0.2);
            await page.mouse.move(x, y, { steps: 5 }).catch(() => {});
            await page.waitForTimeout(100);
            await page.mouse.click(x, y).catch(() => {});
          } else {
            await retryEasyApply.click({ timeout: 3000 }).catch(() => {});
          }
          await page.waitForTimeout(2000);
        }
      }
    }

    if (!modalLoaded) {
      await ctx.appendLog?.('Le formulaire LinkedIn ne s\'est pas chargé (délai dépassé).');
      return {
        success: false,
        note: 'Le formulaire Easy Apply LinkedIn ne s\'est pas chargé (délai dépassé).',
      };
    }

    await ctx.appendLog?.('Formulaire Easy Apply chargé avec succès.');
    await page.waitForTimeout(600);

    // Step through the multi-page Easy Apply modal (up to 8 steps)
    let aiCallsUsed = 0;
    for (let step = 0; step < 8; step++) {
      const stepHeader = await page
        .locator('[role="dialog"]:visible h3, [role="dialog"]:visible h2, .artdeco-modal__header:visible, dialog[open] h2, #dialog-header h2')
        .first()
        .innerText()
        .catch(() => '');
      await ctx.appendLog?.(`Étape ${step + 1} du formulaire LinkedIn ${stepHeader ? `(${stepHeader})` : ''}...`);

      // 1. Phone & Location fields
      await this.fillCvIdentityFields(page, ctx);

      // 2. CV Upload handling (hidden file input OR button)
      const fileInput = await findCvFileInput(page);
      if (fileInput) {
        try {
          await uploadCv(fileInput, ctx);
          await page.waitForTimeout(1500);
          await ctx.appendLog?.('CV téléversé avec succès.');
        } catch (e: any) {
          this.logger.warn(`FileInput error: ${e.message}`);
        }
      }

      // 3. Cover letter if present
      if (ctx.coverLetter) {
        const coverLetterField = page
          .locator('textarea[id*="cover" i], textarea[aria-label*="lettre" i], textarea[aria-label*="cover" i]')
          .first();
        if (await coverLetterField.isVisible().catch(() => false)) {
          await coverLetterField.fill(ctx.coverLetter).catch(() => {});
        }
      }

      // 4. Fill custom questions from learned answers and defaults
      await fillKnownFields(page, ctx.knownAnswers);

      // 5. Incomplete profile experiences cleanup if blocking
      const deleteExpBtn = page.locator('button:has-text("Supprimer"), a:has-text("Supprimer"), [aria-label*="Supprimer"]').first();
      if ((await deleteExpBtn.count().catch(() => 0)) > 0 && (await deleteExpBtn.isVisible().catch(() => false))) {
        await deleteExpBtn.click().catch(() => {});
        await page.waitForTimeout(500);
      }

      // 9. Submit button detection
      const submitButton = page
        .getByRole('button', { name: /submit application|envoyer la candidature|d[e\u00e9]poser la candidature|soumettre/i })
        .or(page.locator('button:has-text("Envoyer la candidature"), button:has-text("Submit application")'))
        .first();

      if (await submitButton.isVisible().catch(() => false)) {
        this.logger.log(`Submitting application for ${ctx.application.id}...`);
        await ctx.appendLog?.('Vérification finale et soumission de la candidature...');
        await humanClick(page, submitButton).catch(() => submitButton.click({ timeout: 5000 }).catch(() => {}));
        await page.waitForTimeout(4000);

        const confirmed = await page
          .getByText(/application sent|candidature envoy[e\u00e9]e|votre candidature a [e\u00e9]t[e\u00e9] envoy[e\u00e9]e/i)
          .first()
          .isVisible()
          .catch(() => false);

        await ctx.appendLog?.('Candidature Easy Apply soumise avec succès !');
        return { success: true, note: confirmed ? undefined : 'Candidature Easy Apply soumise.' };
      }

      // 10. Review button detection
      const reviewButton = page
        .getByRole('button', { name: /review|v[e\u00e9]rifier|examiner/i })
        .or(page.locator('button:has-text("Vérifier"), button:has-text("Review"), button:has-text("Examiner")'))
        .first();

      if (await reviewButton.isVisible().catch(() => false)) {
        await humanClick(page, reviewButton).catch(() => reviewButton.click({ timeout: 5000 }).catch(() => {}));
        await page.waitForTimeout(2000);
        const blockedAfterReview = await page
          .locator('[role="alert"], .artdeco-inline-feedback--error, [class*="error" i]')
          .first()
          .isVisible()
          .catch(() => false);
        if (!blockedAfterReview) continue;
      }

      // 11. Next button detection
      const nextButton = page
        .getByRole('button', { name: /next|suivant|continuer/i })
        .or(page.locator('button:has-text("Suivant"), button:has-text("Next"), button:has-text("Continuer")'))
        .first();

      if (await nextButton.isVisible().catch(() => false)) {
        const progressBefore = await this.readEasyApplyProgress(page);
        await humanClick(page, nextButton).catch(() => nextButton.click({ timeout: 5000 }).catch(() => {}));
        await page.waitForTimeout(2000);
        // Confirmed live (Infogene, new <dialog> UI): the inline error
        // "Saisie non valide" carries hashed class names -- no role=alert,
        // nothing with "error" in it -- so the class-based check below
        // never fired, "Suivant" was clicked eight times on the same 3/5
        // page and the AI fallback never ran. Two more signals: the error
        // WORDING, and the "x/y pages" counter not moving.
        const progressAfter = await this.readEasyApplyProgress(page);
        const errorText = await page
          .locator(EASY_APPLY_MODAL_SELECTOR)
          .first()
          .getByText(/saisie non valide|champ obligatoire|ce champ est requis|entrée non valide|invalid input|required field|please enter|veuillez (saisir|renseigner)/i)
          .first()
          .isVisible()
          .catch(() => false);
        if (errorText || (progressBefore && progressBefore === progressAfter)) {
          // fall through to the AI fallback below
        } else {
        // LinkedIn's "Next" validates the current step — a required field it
        // left empty just re-renders the same step with inline errors
        // ("artdeco-inline-feedback--error"). Blindly `continue`-ing here
        // would re-click the same button every remaining iteration and
        // never give the AI fallback below a chance to fill whatever's
        // actually blocking (confirmed live: this is exactly how a required
        // screening question got skipped silently instead of resolved).
        const blockedAfterNext = await page
          .locator('[role="alert"], .artdeco-inline-feedback--error, [class*="error" i]')
          .first()
          .isVisible()
          .catch(() => false);
        if (!blockedAfterNext) continue;
        }
      }

      // Before trying the AI fallback (or giving up), check whether the
      // application was actually already submitted successfully by an
      // earlier AI-driven action in this same loop — an action the AI
      // itself labeled "next"/"review" rather than "submit" can still be
      // the real final click (confirmed live on the equivalent HelloWork
      // loop: landing on a post-submit page with neither a submit/next
      // button nor any fields left to answer was reported as blocked/failed
      // without ever checking whether the confirmation text was already
      // sitting right there).
      if (await detectFormSuccess(page, EASY_APPLY_SUCCESS_TEXT)) {
        await ctx.appendLog?.('Candidature Easy Apply soumise avec succès !');
        return { success: true };
      }

      // 12. None of the known button texts matched this step — fall back to
      // an AI-read snapshot of the visible form instead of giving up. This
      // is what lets an unfamiliar screening question or an unrecognized
      // button label (any language, any phrasing LinkedIn ships) still get
      // resolved, capped at a user-configurable number of calls per attempt
      // (Paramètres page — "autoApplyMaxAiCalls", 0 disables the fallback)
      // so a genuinely stuck form doesn't burn tokens indefinitely.
      if (aiCallsUsed >= ctx.maxAiCallsPerAttempt) break;

      const snapshot = await buildFormSnapshot(page);
      if (!snapshot.fields.length && !snapshot.buttons.length) break;

      aiCallsUsed++;
      const plan = await this.ai
        .planApplicationFormStep({
          candidateBrief: buildCandidateBrief(ctx),
          jobTitle: ctx.application.jobTitle,
          company: ctx.application.company,
          fieldsText: formatFieldsForPrompt(snapshot.fields),
          buttonsText: formatButtonsForPrompt(snapshot.buttons),
        })
        .catch(() => null);

      if (plan?.usage) {
        await ctx.appendLog?.(
          `IA sollicitée pour cette étape (${plan.usage.promptTokens} tokens entrée / ${plan.usage.completionTokens} sortie).`,
        );
      }

      if (!plan || plan.action.kind === 'stop') break;

      await applyFormPlan(page, plan);
      await page.waitForTimeout(plan.action.kind === 'submit' ? 2500 : 1200);

      if (plan.action.kind === 'submit') {
        const confirmed = await page
          .getByText(/application sent|candidature envoy[eé]e|votre candidature a [eé]t[eé] envoy[eé]e/i)
          .first()
          .isVisible()
          .catch(() => false);
        await ctx.appendLog?.('Candidature Easy Apply soumise avec succès !');
        return { success: true, note: confirmed ? undefined : 'Candidature Easy Apply soumise.' };
      }
      // 'next' / 'review' — loop again with a fresh snapshot.
    }

    const unknownFields = await scanInvalidFields(page);
    if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);

    return {
      success: false,
      note: 'Formulaire Easy Apply non finalisé (étape inattendue) -- à vérifier manuellement.',
    };
  }

  // Confirmed live: every LinkedIn job-view navigation in a campaign run can
  // fail with net::ERR_HTTP_RESPONSE_CODE_FAILURE (a malformed HTTP
  // response), consistently, right after that same run's own LinkedIn
  // search scrape (linkedin-stealth.ts) hit up to ~30 job-view/detail pages
  // in a tight burst from the same un-proxied IP (LINKEDIN_PROXIES isn't
  // configured). Manually replaying the exact same session/URL a few
  // minutes later — after the burst — succeeded immediately, so this reads
  // as a short-lived, IP-level rate-limit reaction rather than a real
  // network fault or a broken session. A real network/DNS failure or an
  // actually-revoked session would keep failing on retry too, so this
  // costs nothing in those cases beyond the wait already worth trying.
  private async gotoWithRateLimitRetry(page: Page, ctx: ApplyContext, url: string): Promise<void> {
    const delaysMs = [8000, 20000];
    for (let attempt = 0; ; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return;
      } catch (err: any) {
        if (!/ERR_HTTP_RESPONSE_CODE_FAILURE/.test(err.message || '') || attempt >= delaysMs.length) throw err;
        await ctx.appendLog?.(
          `LinkedIn a renvoyé une réponse invalide (limitation probable) — nouvelle tentative dans ${delaysMs[attempt] / 1000}s...`,
        );
        await page.waitForTimeout(delaysMs[attempt]);
      }
    }
  }

  private async fillCvIdentityFields(page: Page, ctx: ApplyContext): Promise<void> {
    // Easy Apply almost always reuses the logged-in account's own name/email
    // (non-editable), but a handful of variants do show editable fields —
    // harmless no-op everywhere else since fillIdentityFields only acts on
    // fields it actually finds visible and empty.
    await fillIdentityFields(page, ctx.cv);

    const rawPhone = ctx.cv.phone || '0612345678';
    const cleanPhone = formatFrenchPhone(rawPhone);
    const phoneSelectors = [
      'input[type="tel"]',
      'input[aria-label*="téléphone" i]',
      'input[aria-label*="phone" i]',
      'input[id*="phone" i]',
      'input[name*="phone" i]',
      'input[placeholder*="téléphone" i]',
      'input[placeholder*="phone" i]',
    ];

    for (const sel of phoneSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const currentValue = await el.inputValue().catch(() => '');
        if (!currentValue || currentValue !== cleanPhone) {
          await el.fill(cleanPhone).catch(() => {});
          await ctx.appendLog?.(`Numéro de téléphone renseigné : ${cleanPhone}`);
        }
        break;
      }
    }

    const location = ctx.cv.location || 'Paris, France';
    const locationSelectors = [
      'input[id*="city" i]',
      'input[id*="location" i]',
      'input[name*="city" i]',
      'input[aria-label*="city" i]',
      'input[aria-label*="ville" i]',
      'input[aria-label*="location" i]',
    ];

    for (const sel of locationSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const currentValue = await el.inputValue().catch(() => '');
        if (!currentValue) {
          await el.fill(location).catch(() => {});
          await page.waitForTimeout(500);
          const option = page.locator('[role="option"]').first();
          if (await option.isVisible().catch(() => false)) {
            await option.click().catch(() => {});
          } else {
            await el.press('Escape').catch(() => {});
          }
        }
        break;
      }
    }
  }

    private async handleConsentWall(page: Page, ctx: ApplyContext): Promise<boolean> {
    const isConsent =
      page.url().includes('connect-services') ||
      (await page
        .locator('button:has-text("Oui, garder"), button:has-text("garder les services"), button:has-text("Keep services")')
        .count()
        .catch(() => 0)) > 0;

    if (isConsent) {
      await ctx.appendLog?.('Validation du consentement LinkedIn (services connectés)...');
      const confirmBtn = page
        .locator('button:has-text("Oui, garder"), button:has-text("garder les services"), button:has-text("Keep services"), button.primary-action-btn')
        .first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
        const state = await page.context().storageState().catch(() => null);
        if (state) {
          await ctx.onSessionUpdated?.(JSON.stringify(state));
        }
        return true;
      }
    }
    return false;
  }

  // "3/5 pages" style counter of the Easy Apply modal, or '' when absent.
  private async readEasyApplyProgress(page: Page): Promise<string> {
    const text = await page.locator(EASY_APPLY_MODAL_SELECTOR).first().innerText({ timeout: 2000 }).catch(() => '');
    const match = text.match(/(\d+)\s*\/\s*(\d+)\s*pages?/i);
    return match ? `${match[1]}/${match[2]}` : '';
  }

  private async ensureLoggedIn(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.linkedin.isLoginWallVisible(page);
    if (!onLoginWall) return null;

    await ctx.appendLog?.('Session requise sur LinkedIn mais la session est expirée ou invalide.');
    return {
      success: false,
      sessionExpired: true,
      note: "Session LinkedIn expirée — ouvrez la page Comptes dans FindUrJob et cliquez sur \"Ouvrir la session\" pour LinkedIn afin de vous reconnecter en toute sécurité.",
    };
  }
}
