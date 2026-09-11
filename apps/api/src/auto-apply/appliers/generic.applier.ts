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
  /application submitted|application received|thank you for applying|thanks for applying|we('| ha)ve received your application|your application (has been|was) (received|submitted)|candidature (envoyée|reçue|transmise|enregistrée|bien reçue|prise en compte)|merci (pour votre candidature|d'avoir postulé)|votre candidature a (bien )?été (envoyée|transmise|enregistrée|prise en compte)/i;

// Some ATS confirmation pages navigate to a distinct URL (a "thank-you" /
// "confirmation" page) rather than showing inline text on the same page --
// checked as an extra signal alongside SUCCESS_TEXT rather than a
// replacement for it, since most confirmations are same-page text and a
// URL-only check would false-positive on unrelated redirects.
const SUCCESS_URL = /thank-?you|confirmation|success|merci|candidature-envoyee|application-submitted/i;

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

    const hasPasswordField = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (hasPasswordField) {
      return {
        success: false,
        note: 'Connexion requise sur la plateforme (compte Welcome to the Jungle ou espace candidat) — candidature à effectuer directement sur le lien de l\'offre.',
      };
    }

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

    const confirmed = await this.detectSuccess(page);
    return confirmed
      ? { success: true }
      : {
          success: false,
          note: 'Formulaire soumis mais confirmation non détectée — à vérifier manuellement.',
        };
  }

  // page.getByText only searches the top-level frame -- some ATS embed the
  // post-submit confirmation inside an iframe widget, so a same-page-only
  // check would report "not confirmed" even though the submission actually
  // succeeded. The URL check is a second independent signal for ATS that
  // navigate to a dedicated confirmation/thank-you page instead of showing
  // inline text.
  private async detectSuccess(page: Page): Promise<boolean> {
    if (SUCCESS_URL.test(page.url())) return true;

    for (const frame of page.frames()) {
      const visible = await frame.getByText(SUCCESS_TEXT).first().isVisible().catch(() => false);
      if (visible) return true;
    }

    return false;
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
