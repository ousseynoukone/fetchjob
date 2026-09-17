import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl, fillIdentityFields, uploadCv } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

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

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    const loginResult = await this.ensureLoggedIn(page);
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
    await applyButton.click();
    await page.waitForTimeout(800);

    if (isDropdownToggle) {
      const menuItem = page
        .locator('.dropdown-menu:visible a, .dropdown-menu:visible button, [role="menu"]:visible a, [role="menu"]:visible button')
        .filter({ hasText: /postuler/i })
        .first();
      if (await menuItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await menuItem.click();
        await page.waitForTimeout(1200);
      }
    }

    // France Travail sometimes acts as an aggregator rather than hosting the
    // application itself: clicking "Postuler" can reveal a "Choisissez le
    // partenaire" modal offering one or more external ATS partners (confirmed
    // live: a single "XTRAMILE" card) instead of a native form. Mirrors the
    // Welcome to the Jungle resolution pattern (see resolveWelcomeToTheJungleApplyUrl)
    // -- follow the partner link out to its real URL and hand off to whichever
    // applier owns it, instead of reporting "étape inattendue" for a step this
    // applier could never have filled in anyway.
    const partnerModal = page
      .locator('[role="dialog"], .modal, [class*="popin" i], [class*="popup" i]')
      .filter({ hasText: /choisissez le partenaire/i })
      .first();
    if (await partnerModal.isVisible().catch(() => false)) {
      await ctx.appendLog?.('Cette offre France Travail redirige vers un partenaire externe...');
      const partnerLink = partnerModal
        .locator('a, button')
        .filter({ hasNotText: /fermer|close|annuler/i })
        .first();
      if (await partnerLink.isVisible().catch(() => false)) {
        const externalUrl = await resolveExternalApplyUrl(page, partnerLink, /francetravail\.fr/i);
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
    const externalRedirectNotice = await page
      .getByText(/site de l'employeur|candidature externe|vous allez être redirigé/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (externalRedirectNotice || !page.url().includes('francetravail.fr')) {
      if (!page.url().includes('francetravail.fr')) {
        return { success: false, redirectToExternalUrl: page.url() };
      }
      return {
        success: false,
        note: "Cette offre France Travail redirige vers le site de l'employeur — à traiter manuellement.",
      };
    }

    await fillIdentityFields(page, ctx.cv);

    // `count()`, not `isVisible()` — confirmed live that Playwright's
    // setInputFiles works on a hidden input, same issue found and fixed
    // across every applier here.
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await uploadCv(fileInput, ctx).catch(() => {});
    }

    if (ctx.coverLetter) {
      const coverLetterField = page
        .locator('textarea[id*="lettre" i], textarea[aria-label*="lettre" i], textarea[name*="message" i]')
        .first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await coverLetterField.fill(ctx.coverLetter).catch(() => {});
      }
    }

    return runFormLoop(page, ctx, this.ai, {
      submitText: /envoyer( ma)? candidature|valider ma candidature/i,
      nextText: /suivant|continuer/i,
      successText: /candidature envoyée|votre candidature a bien été (envoyée|transmise)/i,
      blockedNote: 'Le formulaire de candidature France Travail contient un champ non renseigné — à finaliser manuellement.',
      unresolvedNote: 'Soumission France Travail envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }

  private async ensureLoggedIn(page: Page): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.france_travail.isLoginWallVisible(page);
    if (!onLoginWall) return null; // already have a valid, reused session

    return {
      success: false,
      sessionExpired: true,
      note: "Session France Travail absente ou expirée — exécutez `npm run establish-session -- france_travail votre@email.com` sur votre machine pour la rétablir.",
    };
  }
}
