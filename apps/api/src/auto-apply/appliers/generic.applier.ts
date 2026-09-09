import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { splitName, dismissCookieBanner, hasSecurityCheck } from './ats-common';
import { fillKnownFields, scanInvalidFields } from './form-fields';

const REVEAL_BUTTON_TEXT =
  /postuler|apply now|apply for this job|candidater|je postule|submit application|envoyer ma candidature/i;
const SUBMIT_BUTTON_TEXT =
  /submit application|submit my application|apply now|^postuler$|envoyer( ma candidature)?|soumettre|valider ma candidature/i;
const SUCCESS_TEXT =
  /application submitted|thank you for applying|thanks for applying|candidature (envoyée|reçue|transmise|enregistrée)|merci pour votre candidature|votre candidature a bien été (envoyée|transmise|enregistrée)/i;

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

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    if (await hasSecurityCheck(page)) {
      return {
        success: false,
        note: 'Vérification de sécurité affichée par la plateforme — à finaliser manuellement.',
      };
    }

    const revealButton = page
      .getByRole('link', { name: REVEAL_BUTTON_TEXT })
      .or(page.getByRole('button', { name: REVEAL_BUTTON_TEXT }))
      .first();
    if (await revealButton.isVisible().catch(() => false)) {
      await revealButton.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    const { first, last } = splitName(ctx.cv.fullName);
    const filledFirst = await this.fillFirstMatch(page, [/first name|pr[ée]nom/i], first);
    const filledLast = await this.fillFirstMatch(page, [/last name|^nom$|nom de famille/i], last);
    if (!filledFirst && !filledLast) {
      await this.fillFirstMatch(page, [/full name|^name$|nom complet|nom et pr[ée]nom/i], ctx.cv.fullName);
    }
    await this.fillFirstMatch(page, [/^email|adresse e-?mail/i], ctx.cv.email);
    await this.fillFirstMatch(page, [/phone|t[ée]l[ée]phone|mobile/i], ctx.cv.phone);

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await fileInput.setInputFiles(ctx.cvPdfPath).catch(() => {});
    }

    if (ctx.coverLetter) {
      await this.fillFirstMatch(
        page,
        [
          /cover letter|lettre de motivation|motivation|message|additional information|informations compl[ée]mentaires/i,
        ],
        ctx.coverLetter,
      );
    }

    await fillKnownFields(page, ctx.knownAnswers);

    const submitButton = page
      .getByRole('button', { name: SUBMIT_BUTTON_TEXT })
      .or(page.locator('button[type="submit"]'))
      .first();
    if (!(await submitButton.isVisible().catch(() => false))) {
      return {
        success: false,
        note: "Aucun formulaire de candidature exploitable trouvé sur cette page — à finaliser manuellement.",
      };
    }

    await submitButton.click().catch(() => {});
    await page.waitForTimeout(2000);

    if (await hasSecurityCheck(page)) {
      return {
        success: false,
        note: 'Vérification de sécurité affichée après soumission — à finaliser manuellement.',
      };
    }

    const stillHasErrors = await page
      .locator('[role="alert"], .error-message, [class*="error" i]')
      .first()
      .isVisible()
      .catch(() => false);
    if (stillHasErrors) {
      const unknownFields = await scanInvalidFields(page);
      if (unknownFields.length) await ctx.reportUnknownFields(unknownFields);
      return {
        success: false,
        note: 'Le formulaire contient des questions non renseignées — à finaliser manuellement.',
      };
    }

    const confirmed = await page.getByText(SUCCESS_TEXT).first().isVisible().catch(() => false);
    return confirmed
      ? { success: true }
      : {
          success: false,
          note: 'Formulaire soumis mais confirmation non détectée — à vérifier manuellement.',
        };
  }

  // Tries each label pattern in turn (first visible match wins) — a plain
  // getByLabel(onePattern) only ever covers one phrasing, so every field
  // needs a short list of alternatives rather than a single regex.
  private async fillFirstMatch(page: Page, patterns: RegExp[], value: string | undefined | null): Promise<boolean> {
    if (!value) return false;
    for (const pattern of patterns) {
      const locator = page.getByLabel(pattern).or(page.getByPlaceholder(pattern)).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.fill(value).catch(() => {});
        return true;
      }
    }
    return false;
  }
}
