import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, humanClick, humanFill, uploadCv } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

// scraping.service.ts's fetchApecOffers builds the stored sourceUrl as
// .../emploi/detail-offre/{numeroOffre} -- the apply page needs that same
// numeroOffre in its own hash-routed URL (see APPLY_URL below).
function extractNumeroOffre(sourceUrl: string): string | null {
  const match = sourceUrl.match(/detail-offre\/([0-9A-Za-z]+)/);
  return match ? match[1] : null;
}

// Every selector/URL/button-text/success-text below is transcribed directly
// from a real, user-recorded application on APEC (a Chrome DevTools
// Recorder export covering an actual login + submit + confirmation) --
// none of it guessed, unlike the first pass at this file's WTTJ sibling.
@Injectable()
export class ApecApplier implements JobApplier {
  readonly credentialPlatform = 'apec';
  private readonly logger = new Logger(ApecApplier.name);

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    const numeroOffre = extractNumeroOffre(ctx.application.sourceUrl);
    if (!numeroOffre) {
      return {
        success: false,
        note: "Impossible d'identifier le numéro d'offre APEC à partir de son URL — à traiter manuellement.",
      };
    }

    // Confirmed live via the recording: this exact hash-routed URL opens
    // the apply form directly for a given offer, without needing to click
    // through the search results and detail page first.
    const applyUrl = `https://www.apec.fr/candidat/recherche-emploi/postuler-a-une-offre.html#candidature/promotion/${numeroOffre}?to=int`;
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);
    await page.waitForTimeout(2000);

    // Confirmed live: with no valid session, the SAME #emailid/#password
    // login fields the recording used (there, inline on this apply page,
    // via APEC's own apec-candidature-login component) appear instead of
    // the CV/message form below. Never auto-filled here -- same posture as
    // every other account-based applier in this file, only reuses a
    // session established through the in-app remote-login flow.
    if (await SESSION_CHECKS.apec.isLoginWallVisible(page)) {
      await ctx.appendLog?.('APEC a affiché le formulaire de connexion — la session ne semble plus valide.');
      return {
        success: false,
        sessionExpired: true,
        note: 'Session APEC absente ou expirée — ouvrez la session depuis Comptes pour la rétablir.',
      };
    }

    // "Je préfère joindre [mon CV]" vs "Je candidate [avec le CV du site]" --
    // a real choice confirmed in the recording between APEC's own stored CV
    // and a fresh upload. Always want the fresh one (this campaign's
    // AI-adapted CV for this specific offer), not whatever happens to be on
    // file at APEC from some earlier, unrelated upload.
    const attachOwnCv = page.getByText(/je pr[ée]f[èe]re joindre/i).first();
    if (await attachOwnCv.isVisible().catch(() => false)) {
      await humanClick(page, attachOwnCv).catch(() => {});
      await page.waitForTimeout(500);
    }

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await uploadCv(fileInput, ctx).catch(() => {});
    }

    if (ctx.coverLetter) {
      // "Ajouter un message au recruteur ?" -- an accordion tab the
      // recording opened before the #comment textarea underneath it became
      // fillable.
      const messageTab = page.getByText(/ajouter un message au recruteur/i).first();
      if (await messageTab.isVisible().catch(() => false)) {
        await humanClick(page, messageTab).catch(() => {});
        await page.waitForTimeout(500);
      }
      const commentField = page.locator('#comment').first();
      if (await commentField.isVisible().catch(() => false)) {
        await humanFill(commentField, ctx.coverLetter);
      }
    }

    // The recording's own additional ng-select dropdowns (under
    // #comp_additional-data) aren't touched explicitly here -- their exact
    // meaning (availability date? salary expectations?) isn't confirmed,
    // and ng-select is a custom Angular widget a native <select> handler
    // can't drive anyway. Left to the AI-driven fallback below, which reads
    // whatever's actually visible on the page rather than assuming.
    return runFormLoop(page, ctx, this.ai, {
      // Confirmed live via the recording: APEC's real submit button reads
      // exactly "Envoyer ma candidature".
      submitText: /envoyer ma candidature/i,
      nextText: /suivant|continuer/i,
      // Confirmed live via the recording's own confirmation page
      // (promotion-de-service.html): its <h1> reads exactly "Votre
      // candidature a été envoyée".
      successText: /votre candidature a [ée]t[ée] envoy[ée]e/i,
      blockedNote: 'Le formulaire de candidature APEC contient un champ non renseigné — à finaliser manuellement.',
      unresolvedNote: 'Soumission APEC envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }
}
