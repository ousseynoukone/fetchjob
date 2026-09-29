import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { dismissCookieBanner, SESSION_CHECKS, fillIdentityFields, uploadCv, findCvFileInput, clickCvUploadControl } from './ats-common';
import { runFormLoop } from './ai-form-loop';
import { AiService } from '../../ai/ai.service';
import { REMOTE_LOGIN_URLS } from '../../platform-credentials/remote-login.service';

// Built from a real recorded application flow on app.collective.work, then
// substantially corrected against the live site (the recording's own click
// path -- "Postuler" from the list -- turned out to open a NEW TAB showing
// only the job's read-only detail panel, itself containing ANOTHER,
// easily-misidentified "Postuler" button since getByRole matched an
// unrelated icon-only button of the same accessible name first). Confirmed
// live, repeatedly, with real screenshots: the actual application FORM
// lives at its own dedicated, directly-navigable URL --
// /talent/projects-activity/opportunities/<jobId>/overview?application-step=accept-opportunity-step
// -- reachable in one hop from the jobId alone, with no click-through
// needed at all. Also confirmed live: LinkedIn URL and CV are pulled
// automatically from the candidate's Collective Work profile (visible
// pre-filled/pre-attached on the real form) -- fillIdentityFields/CV-upload
// below are kept as a harmless defensive fallback for an account with no
// profile CV yet, not the primary mechanism here. Custom questions render
// as rich-text (ProseMirror/contenteditable) editors, a genuinely new field
// kind handled generically by ai-form-snapshot.ts's 'richtext' kind so any
// future platform using the same pattern benefits too.
@Injectable()
export class CollectiveWorkApplier implements JobApplier {
  readonly credentialPlatform = 'collective_work';
  private readonly logger = new Logger(CollectiveWorkApplier.name);

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    const loginResult = await this.ensureLoggedIn(page, ctx);
    if (loginResult) return loginResult;

    const jobId = ctx.application.sourceUrl.match(/[?&]jobId=([^&]+)/)?.[1];
    if (!jobId) {
      return {
        success: false,
        note: "Impossible d'extraire l'identifiant de l'offre Collective Work depuis son URL — à traiter manuellement.",
      };
    }
    const applyUrl = `https://app.collective.work/talent/projects-activity/opportunities/${jobId}/overview?application-step=accept-opportunity-step&apply=true`;

    // NOT networkidle -- confirmed live it never resolves on this site (a
    // persistent background connection keeps the network "busy"
    // indefinitely) and just burns the full timeout on every single
    // attempt before continuing anyway. domcontentloaded + an explicit
    // wait for real form content is faster and actually reflects when the
    // SPA has finished rendering.
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await dismissCookieBanner(page);

    if (SESSION_CHECKS.collective_work.isLoginWallVisible && (await SESSION_CHECKS.collective_work.isLoginWallVisible(page))) {
      return {
        success: false,
        sessionExpired: true,
        note: 'Collective Work a affiché son écran de connexion au lieu de la fiche offre — session expirée, reconnectez-vous via Paramètres.',
      };
    }

    const submitBtn = page.getByRole('button', { name: /envoyer la candidature/i }).first();
    const hasRealForm = await Promise.race([
      submitBtn.waitFor({ state: 'visible', timeout: 15000 }).then(() => true),
      page.locator('[contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true),
    ]).catch(() => false);
    if (!hasRealForm) {
      return {
        success: false,
        note: "Formulaire de candidature Collective Work introuvable pour cette offre — offre probablement retirée, déjà candidatée, ou déjà enregistrée dans vos opportunités.",
      };
    }
    await page.waitForTimeout(500);

    await fillIdentityFields(page, ctx.cv);

    // Defensive fallback only -- confirmed live the CV normally comes
    // pre-attached from the candidate's own Collective Work profile, with
    // no upload control on the page at all in that case (findCvFileInput
    // simply finds nothing and this becomes a no-op).
    const fileInput = await findCvFileInput(page);
    if (fileInput) {
      await uploadCv(fileInput, ctx).catch(() => {});
    } else {
      await clickCvUploadControl(page).catch(() => false);
    }

    return runFormLoop(page, ctx, this.ai, {
      // Matches both the in-form "Envoyer la candidature" button and the
      // follow-up confirm dialog's bare "Envoyer" — runFormLoop's own
      // step-loop naturally handles the two-stage submit as two
      // iterations, since a snapshot with no fields left and a matching
      // submit button takes the free fast path on the confirm dialog too.
      submitText: /^envoyer( la candidature)?$/i,
      nextText: /suivant|continuer/i,
      successText: /candidature envoy[ée]e|votre candidature a (bien )?[ée]t[ée] envoy[ée]e|merci pour votre candidature|candidature transmise|f[ée]licitations/i,
      successUrl: /candidature|confirmation|merci/i,
      blockedNote: 'Le formulaire de candidature Collective Work contient un champ non renseigné — à finaliser manuellement.',
      unresolvedNote: 'Soumission Collective Work envoyée mais confirmation non détectée — à vérifier manuellement.',
    });
  }

  private async ensureLoggedIn(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    await page.goto(SESSION_CHECKS.collective_work.homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await dismissCookieBanner(page);

    const onLoginWall = await SESSION_CHECKS.collective_work.isLoginWallVisible(page);
    if (!onLoginWall) return null; // already have a valid, reused session

    if (
      ctx.credential?.email &&
      ctx.credential?.password &&
      ctx.credential.email !== '(session importée)' &&
      ctx.credential.email !== '(connecté via navigateur intégré)'
    ) {
      await ctx.appendLog?.(`Session expirée — reconnexion automatique Collective Work avec ${ctx.credential.email}...`);
      try {
        await page.goto(REMOTE_LOGIN_URLS.collective_work, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await dismissCookieBanner(page).catch(() => {});
        await page.waitForTimeout(1500);

        const emailField = page.getByRole('textbox', { name: 'email-input' }).first();
        const passField = page.getByRole('textbox', { name: 'password-input' }).first();
        if ((await emailField.isVisible().catch(() => false)) && (await passField.isVisible().catch(() => false))) {
          await emailField.fill(ctx.credential.email);
          await passField.fill(ctx.credential.password);
          const submitBtn = page.getByRole('button', { name: /se connecter/i }).first();
          if (await submitBtn.isVisible().catch(() => false)) {
            await submitBtn.click();
          } else {
            await passField.press('Enter');
          }
          await page.waitForTimeout(3000);

          const stillOnWall = await SESSION_CHECKS.collective_work.isLoginWallVisible(page);
          if (!stillOnWall) {
            await ctx.appendLog?.('Reconnexion automatique Collective Work réussie !');
            const state = await page.context().storageState().catch(() => null);
            if (state) {
              await ctx.onSessionUpdated?.(JSON.stringify(state));
            }
            return null;
          }
        }
      } catch (err: any) {
        this.logger.warn(`Auto-relogin Collective Work error: ${err.message}`);
      }
    }

    return {
      success: false,
      sessionExpired: true,
      note: 'Session Collective Work absente ou expirée — ouvrez la page Comptes dans Paramètres et connectez-vous via le navigateur intégré.',
    };
  }
}
