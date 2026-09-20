import type { Page } from 'playwright';
import type { AiService } from '../../ai/ai.service';
import { ApplyContext, ApplyResult } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { buildFormSnapshot, applyFormPlan, formatFieldsForPrompt, formatButtonsForPrompt, buildCandidateBrief } from './ai-form-snapshot';
import { humanClick } from './ats-common';

export interface FormLoopOptions {
  maxSteps?: number;
  // Fast path: today's known button text per platform, tried first on every
  // step at zero AI cost — the vast majority of steps on well-known
  // platforms are resolved here exactly as before this engine existed.
  submitText: RegExp;
  nextText: RegExp;
  successText: RegExp;
  successUrl?: RegExp;
  // Used when the form is genuinely stuck (validation error nothing could
  // resolve, or the AI itself gave up).
  blockedNote: string;
  // Used when a submit happened but no confirmation could be confirmed.
  unresolvedNote: string;
}

export async function detectFormSuccess(page: Page, successText: RegExp, successUrl?: RegExp): Promise<boolean> {
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
  const unknownFields = await scanInvalidFields(page).catch(() => []);
  if (unknownFields.length) {
    await ctx.reportUnknownFields(unknownFields);
    const labels = unknownFields.map((f) => f.questionText).join(', ');
    return { success: false, note: `${fallbackNote} (champ(s) bloquant(s) détecté(s) : ${labels})` };
  }
  return { success: false, note: fallbackNote };
}

export async function runFormLoop(page: Page, ctx: ApplyContext, ai: AiService, opts: FormLoopOptions): Promise<ApplyResult> {
  const maxSteps = opts.maxSteps ?? 6;
  let aiCallsUsed = 0;

  for (let step = 0; step < maxSteps; step++) {
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
    const submitButton = page.getByRole('button', { name: opts.submitText }).first();
    if (!preSubmitSnapshot.fields.length && (await submitButton.isVisible().catch(() => false))) {
      await humanClick(page, submitButton).catch(() => {});
      await page.waitForTimeout(2500);
      const confirmed = await detectFormSuccess(page, opts.successText, opts.successUrl);
      return confirmed ? { success: true } : await reportBlockedState(page, ctx, opts.unresolvedNote);
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

    aiCallsUsed++;
    const plan = await ai
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

    if (!plan || plan.action.kind === 'stop') {
      return await reportBlockedState(page, ctx, opts.blockedNote);
    }

    await applyFormPlan(page, plan);
    await page.waitForTimeout(plan.action.kind === 'submit' ? 2500 : 1200);

    if (plan.action.kind === 'submit') {
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
