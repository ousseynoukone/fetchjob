import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, hasSecurityCheck, fillIdentityFields, uploadCv } from './ats-common';
import { fillKnownFields } from './form-fields';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

// Confirmed live on Extia's own career site: its reveal button reads
// "It's a match" -- no wordlist can ever fully cover arbitrary branded CTA
// copy (this pattern of playful/gamified apply buttons shows up across
// several French career sites), so this stays a best-effort, growing list
// rather than a claim of full coverage.
const REVEAL_BUTTON_TEXT =
  /postuler|apply now|apply for this job|candidater|je postule|submit application|envoyer ma candidature|it'?s a match/i;
// `^postuler$` used to require the button's ENTIRE accessible name to be
// exactly "Postuler" -- real buttons are far more often phrased "Postuler
// maintenant" / "Postuler à cette offre", which an anchored match always
// missed. Unanchored now, consistent with every other term in this list.
const SUBMIT_BUTTON_TEXT =
  /submit application|submit my application|apply now|postuler|envoyer( ma candidature)?|soumettre|valider ma candidature/i;
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

  constructor(private ai: AiService) {}

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

    await fillIdentityFields(page, ctx.cv);

    const hasPasswordField = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (hasPasswordField) {
      return {
        success: false,
        note: 'Connexion requise sur la plateforme (compte Welcome to the Jungle ou espace candidat) — candidature à effectuer directement sur le lien de l\'offre.',
      };
    }

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await uploadCv(fileInput, ctx).catch(() => {});
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

    // Confirmed live on a Cegedim career-site apply-time screenshot: its
    // cookie-consent modal was STILL sitting there, undismissed, this deep
    // into the flow — a slower-loading consent-management script can render
    // it after the single dismiss attempt right after page.goto() already
    // ran. A second, cheap attempt right before submission catches that
    // case without duplicating work on sites where it was already cleared.
    await dismissCookieBanner(page);

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
      return {
        success: false,
        note: 'Vérification de sécurité affichée après soumission — à finaliser manuellement.',
      };
    }

    return result;
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
