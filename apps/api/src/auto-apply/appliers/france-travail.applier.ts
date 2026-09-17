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
    // Confirmed live AGAIN even with the above: the banner can reappear in
    // the narrow gap between that dismiss call and this exact click,
    // making the "when do we dismiss it" timing genuinely impossible to
    // pin down from outside. `force: true` sidesteps the whole problem —
    // it skips Playwright's "element actually receives pointer events"
    // actionability check (the literal reason every one of these crashes
    // fired: "<pe-cookies> intercepts pointer events"), while still
    // requiring the real target element to exist and be attached. The
    // banner is a decorative overlay with no functional purpose beyond
    // consent, not something that needs to visibly receive this click.
    await applyButton.click({ force: true }).catch(() => applyButton.click());
    // Confirmed live via a real debug trace: this "Postuler" toggle has
    // data-async-trigger="true" — its dropdown's actual content (a
    // "postuler" menu item, OR the "choisissez le partenaire" partner
    // picker checked further below) is fetched via AJAX after the click,
    // not present in the initial DOM. The isVisible() checks right after
    // this used to resolve near-instantly when nothing matched yet (their
    // own timeouts only bound how long they'll keep *polling*, not how
    // long they take to give up once Playwright decides nothing will ever
    // match), so the real wall-clock gap between this click and those
    // checks could end up far shorter than 800ms — not long enough for the
    // AJAX call to land. A real reproduction confirmed both branches
    // finding nothing (count=0) purely from this timing gap, on a job
    // whose partner-picker markup was independently confirmed correct.
    // Widened to give that request genuine room to complete.
    await page.waitForTimeout(2500);

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
    // partenaire" panel offering one or more external ATS partners (confirmed
    // live: a single "XTRAMILE" card in a modal, AND separately a single
    // "PMEJOB" link inside the SAME dropdown menu the isDropdownToggle branch
    // above already opens) instead of a native form. That branch only ever
    // looks for a menu item literally reading "postuler" — a partner-picker
    // dropdown never has one (its links are named after the partner, e.g.
    // "PMEJOB"), so it silently falls through here every time, and this
    // check used to require a `[role="dialog"]`/`.modal`/`popin`/`popup`
    // container, none of which a plain `.dropdown-menu` ever matches either.
    // Confirmed live via a real form snapshot: with neither branch ever
    // firing, the applier ran fillIdentityFields/runFormLoop against the
    // original job page with the dropdown still open over it — no real form
    // ever existed there, so every AI call saw the same near-empty snapshot
    // and produced the same stuck non-answer every single time. Mirrors the
    // Welcome to the Jungle resolution pattern (see
    // resolveWelcomeToTheJungleApplyUrl) -- follow the partner link out to
    // its real URL and hand off to whichever applier owns it, instead of
    // ever reaching the AI loop for a step this applier could never have
    // filled in anyway.
    const partnerModal = page
      .locator('[role="dialog"], .modal, [class*="popin" i], [class*="popup" i], .dropdown-menu')
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
