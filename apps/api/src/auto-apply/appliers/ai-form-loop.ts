import type { Page } from 'playwright';
import type { AiService } from '../../ai/ai.service';
import { ApplyContext, ApplyResult } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { buildFormSnapshot, applyFormPlan, formatFieldsForPrompt, formatButtonsForPrompt, buildCandidateBrief } from './ai-form-snapshot';

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
  return false;
}

// Shared step-loop for every "fill known fields, submit, or advance" style
// applier (HelloWork, France Travail, Indeed, Workday, Greenhouse, Lever,
// SmartRecruiters, and the generic fallback). Each step tries the
// platform's own known button text first (free); only when that resolves
// nothing does it fall back to an AI-read snapshot of the visible form —
// which is what lets the exact same code keep working on a platform whose
// copy/markup this project has never seen before.
export async function runFormLoop(page: Page, ctx: ApplyContext, ai: AiService, opts: FormLoopOptions): Promise<ApplyResult> {
  const maxSteps = opts.maxSteps ?? 6;
  let aiCallsUsed = 0;

  for (let step = 0; step < maxSteps; step++) {
    await fillKnownFields(page, ctx.knownAnswers);

    const submitButton = page.getByRole('button', { name: opts.submitText }).first();
    if (await submitButton.isVisible().catch(() => false)) {
      await submitButton.click().catch(() => {});
      await page.waitForTimeout(2500);
      const confirmed = await detectFormSuccess(page, opts.successText, opts.successUrl);
      return confirmed ? { success: true } : { success: false, note: opts.unresolvedNote };
    }

    const nextButton = page.getByRole('button', { name: opts.nextText }).first();
    if (await nextButton.isVisible().catch(() => false)) {
      await nextButton.click().catch(() => {});
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
    // field) just isn't one of the ones already hardcoded for. Try the AI
    // fallback before giving up, up to the user-configurable cap (Paramètres
    // page — "autoApplyMaxAiCalls", 0 disables the fallback entirely).
    if (aiCallsUsed >= ctx.maxAiCallsPerAttempt) {
      const unknownFields = await scanInvalidFields(page);
      if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);
      return { success: false, note: opts.blockedNote };
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
      const unknownFields = await scanInvalidFields(page);
      if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);
      return { success: false, note: opts.blockedNote };
    }

    await applyFormPlan(page, plan);
    await page.waitForTimeout(plan.action.kind === 'submit' ? 2500 : 1200);

    if (plan.action.kind === 'submit') {
      const confirmed = await detectFormSuccess(page, opts.successText, opts.successUrl);
      return confirmed ? { success: true } : { success: false, note: opts.unresolvedNote };
    }
    // 'next' / 'review' — loop again with a fresh snapshot.
  }

  return { success: false, note: opts.blockedNote };
}
