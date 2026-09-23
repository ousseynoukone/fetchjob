import type { Page } from 'playwright';
import type { AiService } from '../../ai/ai.service';
import { ApplyContext, ApplyResult } from './applier.interface';
import { fillKnownFields, scanInvalidFields, normalizeLabel } from './form-fields';
import { applicationScope } from './ai-form-snapshot';
import { buildFormSnapshot, applyFormPlan, formatFieldsForPrompt, formatButtonsForPrompt, buildCandidateBrief } from './ai-form-snapshot';
import { humanClick, hasSecurityCheck, trySolveSlideChallenge, fillIdentityFields, resolveExternalApplyUrl, hasJobClosedIndicator, tickConsentCheckboxes, clickCvUploadControl, findCvFileInput, uploadCv } from './ats-common';

// A generic career-site form can offer "Apply with LinkedIn/Google/..." as
// one of its own buttons; a step the model reads as "next"/"continue" can
// click straight through it and land on that provider's real login/signup
// page. None of these is ever a form this applier can complete headless.
// Same LinkedIn login/signup path fragments SESSION_CHECKS.linkedin already
// treats as its own login wall, reused here for the "not even on LinkedIn's
// own applier" case.
const THIRD_PARTY_AUTH_HOST =
  /linkedin\.com\/(login|uas\/login|checkpoint\/|signup|authwall|start\/join)|accounts\.google\.com|appleid\.apple\.com|(^|\/\/)([\w-]+\.)?facebook\.com\/login|login\.microsoftonline\.com/i;

export interface FormLoopOptions {
  maxSteps?: number;
  // Fast path: today's known button text per platform, tried first on every
  // step at zero AI cost — the vast majority of steps on well-known
  // platforms are resolved here exactly as before this engine existed.
  submitText: RegExp;
  nextText: RegExp;
  successText: RegExp;
  // Runs right before every submit click (both the fast path and the
  // AI-planned one) -- for platform quirks that must be re-applied last,
  // e.g. Lever's geocoded location, which its own resume parsing resets.
  beforeSubmit?: () => Promise<void>;
  successUrl?: RegExp;
  // Used when the form is genuinely stuck (validation error nothing could
  // resolve, or the AI itself gave up).
  blockedNote: string;
  // Used when a submit happened but no confirmation could be confirmed.
  unresolvedNote: string;
}

export async function detectFormSuccess(page: Page, successText: RegExp, successUrl?: RegExp): Promise<boolean> {
  if (await hasSecurityCheck(page)) return false;
  if (successUrl?.test(page.url())) return true;
  // Checked across every frame, not just the top-level page — some ATS embed
  // the post-submit confirmation inside an iframe widget.
  for (const frame of page.frames()) {
    const visible = await frame.getByText(successText).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  // Checked across page body text to catch split spans, toasts, and dynamic headers
  const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  if (successText.test(bodyText)) return true;
  return false;
}

// Shared step-loop for every "fill known fields, submit, or advance" style
// applier (HelloWork, France Travail, Indeed, Workday, Greenhouse, Lever,
// SmartRecruiters, and the generic fallback). Each step tries the
// platform's own known button text first (free); only when that resolves
// nothing does it fall back to an AI-read snapshot of the visible form —
// which is what lets the exact same code keep working on a platform whose
// copy/markup this project has never seen before.
// Confirmed live on an external partner site's own apply form: a required
// "Nom" field was left empty (a separate, since-fixed bug in
// fillIdentityFields), the browser's own native HTML5 validation silently
// blocked the click on submit — a required-but-empty field is never
// missable to `:invalid`/`el.required && !el.value`, that's exactly what
// scanInvalidFields already checks for on the AI-fallback paths below — yet
// a submit that never got confirmed used to always report the same vague
// "submitted, but couldn't confirm" note regardless of WHY, indistinguishable
// from a submission that genuinely went through but whose confirmation text
// just didn't match. Actively checking what's actually still wrong on the
// page turns "check manually" into either a specific, learnable question
// (a real unknown/invalid field) or the original honest "can't tell" note
// when nothing is actually detectably wrong.
async function reportBlockedState(page: Page, ctx: ApplyContext, fallbackNote: string): Promise<ApplyResult> {
  const unknownFields = await scanInvalidFields(page, await applicationScope(page)).catch(() => []);
  if (unknownFields.length) {
    await ctx.reportUnknownFields(unknownFields);
    const labels = unknownFields.map((f) => f.questionText).join(', ');
    return { success: false, note: `${fallbackNote} (champ(s) bloquant(s) détecté(s) : ${labels})` };
  }
  return { success: false, note: fallbackNote, needsReview: fallbackNote.includes('à vérifier manuellement') };
}

// One log line with what the form holds right before a submit -- the
// screenshot only ever shows the page AFTER the platform reacted (confirmed
// live: three France Travail "erreur technique" verdicts in a row with no
// way to tell what had actually been sent). Values are clipped; password
// fields are never read.
async function describeFormState(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const out: string[] = [];
      const doc: any = (globalThis as any).document;
      const els = Array.from(doc.querySelectorAll('input:not([type=hidden]):not([type=password]):not([type=submit]):not([type=button]), textarea, select')) as any[];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const type = (el.type || '').toLowerCase();
        let value = '';
        if (type === 'checkbox' || type === 'radio') {
          if (!el.checked) continue;
          value = '☑';
        } else if (el.tagName === 'SELECT') value = el.options?.[el.selectedIndex]?.text || '';
        else if (type === 'file') value = el.files?.length ? `${el.files.length} fichier` : 'aucun fichier';
        else value = String(el.value || '');
        if (!value) continue;
        const label = (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || type).trim().replace(/\s+/g, ' ').slice(0, 24);
        out.push(`${label}=${value.replace(/\s+/g, ' ').slice(0, 28)}`);
      }
      return out.join(' | ').slice(0, 600);
    })
    .catch(() => '');
}

export async function runFormLoop(page: Page, ctx: ApplyContext, ai: AiService, opts: FormLoopOptions): Promise<ApplyResult> {
  const maxSteps = opts.maxSteps ?? 6;
  let aiCallsUsed = 0;
  let lastSnapshotSignature = '';

  for (let step = 0; step < maxSteps; step++) {
    if (await hasSecurityCheck(page)) {
      const solved = await trySolveSlideChallenge(page);
      if (!solved) {
        return { success: false, note: 'CAPTCHA ou test anti-robot détecté — veuillez valider la candidature manuellement ou rafraîchir la session.' };
      }
      await page.waitForTimeout(2000); // give it time to proceed after slide
    }

    // A page that says the posting is gone has no form worth filling --
    // checked every step, since a career site can only reveal this after
    // a client-side redirect the applier's initial check ran before.
    if (await hasJobClosedIndicator(page)) {
      return { success: false, note: "L'offre n'est plus disponible sur le site du recruteur (expirée ou pourvue) — à ignorer." };
    }

    // A step's own "Postuler avec LinkedIn / Google / ..." button can carry
    // the page away to that provider's real sign-up/login screen mid-loop
    // (confirmed live: a SOFTEAM offer ended the attempt on LinkedIn's own
    // "Inscrivez-vous, c'est gratuit" page after a step the model read as
    // "next"). None of these are ever a fillable application form here --
    // there is no OAuth session to complete them with.
    if (THIRD_PARTY_AUTH_HOST.test(page.url())) {
      return {
        success: false,
        note: `Le formulaire a été remplacé par une page de connexion tierce (${new URL(page.url()).hostname}) — candidature à finaliser manuellement.`,
      };
    }

    // Check if an external redirect button appeared (e.g. "Postuler sur le site du recruteur")
    // HelloWork-only by construction (the ownDomain below is HelloWork's):
    // on any other site this returned the CURRENT page as a "redirect",
    // which the orchestrator could no longer follow -- confirmed live on a
    // Taleez form that ended as "à vérifier — undefined".
    const externalRecruiterBtn = page
      .locator('button, a, [role="button"]')
      .filter({ hasText: /sur le site du recruteur|sur le site employeur|sur le site du partenaire/i })
      .first();
    if (/hellowork\.com/i.test(page.url()) && (await externalRecruiterBtn.isVisible().catch(() => false))) {
      const extUrl = await resolveExternalApplyUrl(page, externalRecruiterBtn, /hellowork\.com/i);
      if (extUrl) {
        return { success: false, redirectToExternalUrl: extUrl };
      }
    }

    // Always fill any standard identity fields (phone, name, email, civility...) that appeared in this step
    await fillIdentityFields(page, ctx.cv).catch(() => {});
    await tickConsentCheckboxes(page).catch(() => 0);
    // A step that only now shows the upload control (multi-step forms:
    // Michael Page's step 2) still needs the CV.
    const emptyFileInput = await page
      .locator('input[type="file"]')
      .evaluateAll((els: any[]) => els.some((e) => !e.files || e.files.length === 0))
      .catch(() => false);
    const anyFileInput = (await page.locator('input[type="file"]').count().catch(() => 0)) > 0;
    if (!anyFileInput || emptyFileInput) {
      const input = await findCvFileInput(page);
      if (input && (await input.evaluate((e: any) => !e.files || e.files.length === 0).catch(() => false))) {
        await uploadCv(input, ctx).catch(() => {});
      } else if (!input) {
        await clickCvUploadControl(page).catch(() => false);
      }
    }
    await fillKnownFields(page, ctx.knownAnswers);

    // Confirmed live on a Viveris career-site apply attempt: its "Postuler"
    // submit button is visible on the page from the very first step,
    // alongside two still-unchecked required GDPR-consent checkboxes that
    // neither fillIdentityFields nor fillKnownFields ever touch. This fast
    // path used to fire on ANY step purely off "is a known submit button
    // visible", so it clicked submit immediately on step 0 — failing
    // validation — and returned "unresolved" without ever reaching the
    // AI-snapshot path below, since aiCallsUsed never left 0. A quick,
    // AI-free snapshot scan (buildFormSnapshot only reads the DOM; the AI
    // call is the separate, costed step further down) now gates the fast
    // path on there being nothing left it can already see as unresolved —
    // preserving the free/fast route for the common case (a form
    // fillIdentityFields/fillKnownFields already fully completed) while
    // deferring to the AI for a field neither of those own.
    const preSubmitSnapshot = await buildFormSnapshot(page);
    // A page whose only fields are a job SEARCH form is not an application
    // form -- confirmed live: the model dutifully filled "Recherche par
    // mots-clés" / "Recherche par ville" / alert frequency on Capgemini's
    // career site and clicked "Rechercher" as the submit.
    const searchLike = /recherche par|mots?-cl[ée]s?|^rechercher|fr[ée]quence.*alerte|cr[ée]er une alerte|job title, keywords|search jobs/i;
    if (preSubmitSnapshot.fields.length && preSubmitSnapshot.fields.every((f) => searchLike.test(f.label))) {
      return { success: false, note: "La page d'arrivée est une page de recherche d'offres, pas un formulaire de candidature (offre probablement retirée) — à ignorer." };
    }
    const submitButton = page.getByRole('button', { name: opts.submitText }).first();
    if (!preSubmitSnapshot.fields.length && (await submitButton.isVisible().catch(() => false))) {
      if (opts.beforeSubmit) await opts.beforeSubmit().catch(() => {});
      await ctx.appendLog?.(`Envoi du formulaire — contenu : ${await describeFormState(page)}`);
      await humanClick(page, submitButton).catch(() => {});
      
      // Poll for confirmation up to 8 seconds to accommodate slow SPAs (like France Travail)
      let confirmed = false;
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(1000);
        confirmed = await detectFormSuccess(page, opts.successText, opts.successUrl);
        if (confirmed) break;
      }
      
      return confirmed ? { success: true } : await reportBlockedState(page, ctx, opts.unresolvedNote);
    }
    
    // Check if a CAPTCHA popped up dynamically after the first fast-path interactions
    if (await hasSecurityCheck(page)) {
      const solved = await trySolveSlideChallenge(page);
      if (!solved) {
         return {
           success: false,
           note: 'CAPTCHA ou test anti-robot détecté en cours de saisie — veuillez valider manuellement.',
         };
      }
      await page.waitForTimeout(2000);
    }

    const nextButton = page.getByRole('button', { name: opts.nextText }).first();
    if (await nextButton.isVisible().catch(() => false)) {
      await humanClick(page, nextButton).catch(() => {});
      await page.waitForTimeout(1200);
      // Some "next" buttons (e.g. HelloWork's "Continuer ma candidature")
      // actually validate the current step rather than freely advancing —
      // clicking one that's blocked by empty required fields just re-renders
      // the same step with inline errors. Blindly `continue`-ing here would
      // re-click the exact same button every remaining iteration, silently
      // exhausting the whole attempt without ever trying the AI fallback
      // (confirmed live: this is exactly what left Nom/Email/consent
      // unfilled with the AI never once invoked). Only treat it as real
      // progress if no validation error is now visible.
      const stillBlocked = await page.locator('[role="alert"], [class*="error" i]').first().isVisible().catch(() => false);
      if (!stillBlocked) continue;
    }
    
    if (await hasSecurityCheck(page)) {
      const solved = await trySolveSlideChallenge(page);
      if (!solved) {
         return {
           success: false,
           note: 'CAPTCHA ou test anti-robot détecté en cours de saisie — veuillez valider manuellement.',
         };
      }
      await page.waitForTimeout(2000);
    }

    // Neither a known submit nor a known "next" matched this step, or the
    // "next" click above didn't actually get past a validation error —
    // either way, this platform's copy/markup (or this particular required
    // field) just isn't one of the ones already hardcoded for. Before
    // trying the AI fallback (or giving up), check whether the application
    // was actually already submitted successfully by an earlier step in
    // this same loop — confirmed live on HelloWork: the real submit had
    // already happened via an AI-driven "next"-labeled action a step
    // earlier, landing on HelloWork's own post-submit "apply to more
    // offers" upsell page, which has neither a submit/next button nor any
    // fields the AI recognized as answerable — so it correctly said "stop",
    // and this loop reported it as blocked/failed without ever checking
    // whether the confirmation text was already sitting right there.
    if (await detectFormSuccess(page, opts.successText, opts.successUrl)) {
      return { success: true };
    }

    // Up to the user-configurable cap (Paramètres page —
    // "autoApplyMaxAiCalls", 0 disables the fallback entirely).
    if (aiCallsUsed >= ctx.maxAiCallsPerAttempt) {
      return await reportBlockedState(page, ctx, opts.blockedNote);
    }

    const snapshot = await buildFormSnapshot(page);
    if (!snapshot.fields.length && !snapshot.buttons.length) break; // genuinely nothing left to act on

    const currentSignature = `${snapshot.fields.map((f) => `${f.idx}:${f.label}`).join('|')}::${snapshot.buttons.map((b) => `${b.idx}:${b.text}`).join('|')}`;
    if (currentSignature === lastSnapshotSignature && aiCallsUsed > 0) {
      await ctx.appendLog?.('Formulaire figé : la page ne progresse pas après la dernière action. Arrêt du cycle pour éviter la surconsommation inutile de tokens.');
      return await reportBlockedState(page, ctx, opts.blockedNote);
    }
    lastSnapshotSignature = currentSignature;

    aiCallsUsed++;
    const plan = await ai
      .planApplicationFormStep({
        candidateBrief: buildCandidateBrief(ctx, `${snapshot.markup} ${formatFieldsForPrompt(snapshot.fields)}`),
        jobTitle: ctx.application.jobTitle,
        company: ctx.application.company,
        fieldsText: formatFieldsForPrompt(snapshot.fields),
        buttonsText: formatButtonsForPrompt(snapshot.buttons),
        markupText: snapshot.markup,
      })
      .catch(() => null);

    if (plan?.usage) {
      await ctx.appendLog?.(
        `IA sollicitée pour cette étape (${plan.usage.promptTokens} tokens entrée / ${plan.usage.completionTokens} sortie).`,
      );
    }

    if (!plan || plan.action.kind === 'stop') {
      return await reportBlockedState(page, ctx, opts.blockedNote);
    }

    // Automatically cache any questions answered by the AI into knownAnswers
    // and CustomQuestion DB so next time, no AI call is needed for these questions.
    const answeredEntries: { questionText: string; answer: string; fieldType: string; options?: string[] }[] = [];
    for (const f of plan.fields || []) {
      if (typeof f?.idx !== 'number' || !f.value || !f.value.trim()) continue;

      const regularField = snapshot.fields.find((sf) => sf.idx === f.idx);
      if (regularField && regularField.label) {
        // A select answer is only worth remembering if it IS one of the
        // options. Confirmed live on Direct Emploi: the model answered
        // "Métier" with the job title and "Domaine d'expertise" with a
        // guess, both got cached as known answers, and every later attempt
        // on that form re-applied them (one never matched an option, the
        // other picked a wrong sector) before the model could correct them.
        if (regularField.kind === 'select' && regularField.options?.length) {
          const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
          const wanted = norm(f.value);
          const matched = regularField.options.find((o) => norm(o) === wanted || norm(o).includes(wanted) || wanted.includes(norm(o)));
          if (!matched) continue;
          f.value = matched;
        }
        // Same reasoning as the select guard above, for a URL-named field
        // (X/Twitter, LinkedIn, GitHub, portfolio...): confirmed live, the
        // model answered a one-letter "X" label with "Oui" -- rejected at
        // fill time by the URL guard in applyFormPlan, but still cached
        // here as the "known answer", so every later occurrence of that
        // same question kept silently failing the same way instead of
        // ever getting a real chance to answer it (or surface it to the
        // person to answer once themselves).
        const isUrlLabel = /\burl\b|\blien\b|\blink\b|twitter|linkedin|github|gitlab|portfolio|site web|website/i.test(regularField.label) || /^x$|^x \(twitter\)$/i.test(regularField.label.trim());
        if (isUrlLabel && !/^https?:\/\//i.test(f.value.trim())) continue;
        answeredEntries.push({
          questionText: regularField.label,
          answer: f.value,
          fieldType: regularField.kind,
          options: regularField.options,
        });
        ctx.knownAnswers?.set(normalizeLabel(regularField.label), f.value);
        continue;
      }

      const radioGroup = snapshot.fields.find(
        (sf) => sf.kind === 'radio-group' && sf.radioOptions?.some((ro) => ro.idx === f.idx),
      );
      if (radioGroup && radioGroup.label) {
        const option = radioGroup.radioOptions?.find((ro) => ro.idx === f.idx);
        const ans = option?.text || f.value;
        answeredEntries.push({
          questionText: radioGroup.label,
          answer: ans,
          fieldType: 'radio',
          options: radioGroup.radioOptions?.map((ro) => ro.text) || [],
        });
        ctx.knownAnswers?.set(normalizeLabel(radioGroup.label), ans);
      }
    }

    if (answeredEntries.length && ctx.saveAnsweredFields) {
      await ctx.saveAnsweredFields(answeredEntries).catch(() => {});
    }

    if (plan.action.kind === 'submit' && opts.beforeSubmit) {
      // The plan's own fields first, the platform's last-word tweak next,
      // then the click the plan asked for.
      await applyFormPlan(page, { ...plan, action: { ...plan.action, idx: null } });
      await opts.beforeSubmit().catch(() => {});
      await applyFormPlan(page, { fields: [], action: plan.action });
    } else {
      await applyFormPlan(page, plan);
    }
    if (plan.action.kind === 'submit') await ctx.appendLog?.(`Envoi du formulaire — contenu : ${await describeFormState(page)}`);
    await page.waitForTimeout(plan.action.kind === 'submit' ? 2500 : 1200);

    if (plan.action.kind === 'submit') {
      if (await hasSecurityCheck(page)) {
        const solved = await trySolveSlideChallenge(page);
        if (!solved) {
           return { success: false, note: 'CAPTCHA ou test anti-robot détecté après la soumission — veuillez valider manuellement.' };
        }
        await page.waitForTimeout(2000);
      }
      const confirmed = await detectFormSuccess(page, opts.successText, opts.successUrl);
      if (confirmed) return { success: true };
      // Confirmed live on a Viveris career-site apply attempt: the model's
      // completion was only 33 tokens — barely enough to address ONE of two
      // separate required GDPR-consent checkboxes — then it called "submit"
      // anyway, which stayed on the same page blocked by the other one.
      // Previously this returned "unresolved" immediately, wasting the rest
      // of the attempt's step/AI-call budget on a form that was one field
      // away from done. Falls through to loop again instead — a fresh
      // snapshot won't re-offer whatever the plan already answered (checked
      // boxes and filled fields are excluded by buildFormSnapshot itself),
      // so this either finishes the job on the next pass or, if the page
      // genuinely has nothing left to act on, hits the loop's own
      // no-fields-no-buttons break just below instead of looping forever.
    }
    // 'next' / 'review' / an unconfirmed 'submit' — loop again with a fresh snapshot.
  }

  return await reportBlockedState(page, ctx, opts.blockedNote);
}
