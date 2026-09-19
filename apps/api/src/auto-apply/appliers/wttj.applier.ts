import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, fillIdentityFields, uploadCv } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';

// Only ever reached for the postings resolveWelcomeToTheJungleApplyUrl
// (ats-common.ts) already confirmed stay on welcometothejungle.com instead
// of redirecting to an external ATS -- its own href for those is
// `/fr/authenticate/signin`, which without a real session is a dead end.
// With one, the same "Postuler" link instead leads to WTTJ's own native
// application page. Never attempts login itself (same posture as every
// other account-based applier here) -- only reuses a session established
// through the in-app remote-login flow.
@Injectable()
export class WelcomeToTheJungleApplier implements JobApplier {
  readonly credentialPlatform = 'welcome_to_the_jungle';
  private readonly logger = new Logger(WelcomeToTheJungleApplier.name);

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    const loginResult = await this.ensureLoggedIn(page);
    if (loginResult) return loginResult;

    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);
    await page.waitForTimeout(2000); // same WAF-challenge/SPA-hydration delay as resolveWelcomeToTheJungleApplyUrl

    const applyLink = page.locator('a[data-role="job:apply"]').first();
    const hasApplyLink = await applyLink.isVisible().catch(() => false);
    if (!hasApplyLink) {
      return {
        success: false,
        note: "Bouton de candidature Welcome to the Jungle introuvable sur cette offre — à traiter manuellement.",
      };
    }

    await applyLink.click().catch(() => {});
    await page.waitForTimeout(2000);

    // A stale/invalid session lands back on the signin page instead of the
    // native form -- the same login-wall check catches it here as it would
    // proactively, since a session can die between SessionHealthService's
    // last check and this exact attempt.
    if (await SESSION_CHECKS.welcome_to_the_jungle.isLoginWallVisible(page)) {
      await ctx.appendLog?.('Welcome to the Jungle a renvoyé vers la connexion — la session ne semble plus valide.');
      return {
        success: false,
        sessionExpired: true,
        note: 'Session Welcome to the Jungle absente ou expirée — ouvrez la session depuis Comptes pour la rétablir.',
      };
    }

    await fillIdentityFields(page, ctx.cv);

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count().catch(() => 0)) {
      await uploadCv(fileInput, ctx).catch(() => {});
    }

    if (ctx.coverLetter) {
      const coverLetterField = page
        .locator('textarea[id*="message" i], textarea[name*="message" i], textarea[aria-label*="lettre" i]')
        .first();
      if (await coverLetterField.isVisible().catch(() => false)) {
        await coverLetterField.fill(ctx.coverLetter).catch(() => {});
      }
    }

    // Submit/success wording below is NOT live-verified against a real
    // account (none was available while building this) -- best-effort,
    // French-first patterns consistent with this file's other appliers.
    // Expect to tighten these once a real run reports a false
    // "confirmation non détectée".
    return runFormLoop(page, ctx, this.ai, {
      submitText: /envoyer( ma)? candidature|postuler/i,
      nextText: /suivant|continuer/i,
      successText: /candidature envoyée|votre candidature (a bien été|va être) (envoyée|transmise)/i,
      blockedNote: 'Le formulaire de candidature Welcome to the Jungle contient un champ non renseigné — à finaliser manuellement.',
      unresolvedNote: 'Soumission Welcome to the Jungle envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }

  private async ensureLoggedIn(page: Page): Promise<ApplyResult | null> {
    await page.goto(SESSION_CHECKS.welcome_to_the_jungle.homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await dismissCookieBanner(page);

    const onLoginWall = await SESSION_CHECKS.welcome_to_the_jungle.isLoginWallVisible(page);
    if (!onLoginWall) return null;

    return {
      success: false,
      sessionExpired: true,
      note: 'Session Welcome to the Jungle absente ou expirée — ouvrez la session depuis Comptes pour la rétablir.',
    };
  }
}
