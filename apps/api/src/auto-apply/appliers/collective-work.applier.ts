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
// needed, PROVIDED an "opportunity" record already exists for this account
// (always true for a job this applier's own scraper found, since that
// scraper only ever lists jobs already matched to the candidate). Also
// confirmed live: LinkedIn URL and CV are pulled automatically from the
// candidate's Collective Work profile (visible pre-filled/pre-attached on
// the real form) -- fillIdentityFields/CV-upload below are kept as a
// harmless defensive fallback for an account with no profile CV yet, not
// the primary mechanism here. Custom questions render as rich-text
// (ProseMirror/contenteditable) editors, a genuinely new field kind handled
// generically by ai-form-snapshot.ts's 'richtext' kind so any future
// platform using the same pattern benefits too.
//
// A SECOND path exists for a job reached via a redirect hop from another
// source (an Adzuna/HelloWork posting whose employer turned out to be
// Collective Work): that lands on Collective Work's PUBLIC
// www.collective.work/jobs/... page, not its own app.collective.work
// listing, so there is no jobId in the URL -- and critically, no
// "opportunity" record either, since the candidate was never matched to it
// by Collective Work's own system. Direct-navigating the opportunities URL
// with the project id pulled from that public page's own __NEXT_DATA__
// (confirmed live: it IS the same id) just bounces to "Mes opportunités"
// with nothing there -- the record only gets created by actually going
// through the UI. Confirmed live, repeatedly, with a real session: opening
// the job's detail panel from the internal /talent/jobs?jobId=... listing
// (a REAL mouse click on the title -- a JS-dispatched el.click() does NOT
// trigger it, confirmed live) and clicking THAT panel's own "Postuler"
// button creates the opportunity and lands on the exact same
// /talent/projects-activity/opportunities/<id>/overview URL as the direct
// path above. See openFormViaPublicListing() for the click sequence.
@Injectable()
export class CollectiveWorkApplier implements JobApplier {
  readonly credentialPlatform = 'collective_work';
  private readonly logger = new Logger(CollectiveWorkApplier.name);

  constructor(private ai: AiService) {}

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    const loginResult = await this.ensureLoggedIn(page, ctx);
    if (loginResult) return loginResult;

    const jobId = ctx.application.sourceUrl.match(/[?&]jobId=([^&]+)/)?.[1];
    if (jobId) {
      const applyUrl = `https://app.collective.work/talent/projects-activity/opportunities/${jobId}/overview?application-step=accept-opportunity-step&apply=true`;
      // NOT networkidle -- confirmed live it never resolves on this site (a
      // persistent background connection keeps the network "busy"
      // indefinitely) and just burns the full timeout on every single
      // attempt before continuing anyway. domcontentloaded + an explicit
      // wait for real form content is faster and actually reflects when the
      // SPA has finished rendering.
      await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await dismissCookieBanner(page);
    } else {
      const outcome = await this.openFormViaPublicListing(page, ctx);
      if (outcome === 'session-expired') {
        return {
          success: false,
          sessionExpired: true,
          note: 'Collective Work a affiché son écran de connexion au lieu de la fiche offre — session expirée, reconnectez-vous via Paramètres.',
        };
      }
      if (outcome === 'not-found') {
        return {
          success: false,
          note: "Offre Collective Work découverte via une autre plateforme (redirection externe) — son formulaire de candidature n'a pas pu être ouvert automatiquement pour cette offre précise, à vérifier manuellement depuis le lien d'origine de l'offre.",
        };
      }
      // outcome === 'opened': page is already sitting on the real
      // opportunities/overview URL, same place the direct jobId path above
      // lands -- fall through into the exact same form-handling logic.
    }

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
    // hasRealForm only waited for the FIRST of submitBtn/richtext to show up
    // -- confirmed live (Tactik Consulting offer, real screenshot): the
    // submit button is static chrome that renders immediately, while a
    // job's own custom questions (plain text inputs, not always
    // contenteditable) can still be fetching/rendering a beat later. A
    // fixed 500ms guess wasn't always enough and the form got submitted
    // with required fields still empty -- rejected ("Ce champ est requis")
    // right there, with nothing ever typed into them. Poll the count of
    // actual input/textarea/contenteditable fields instead of guessing a
    // duration: once two checks 800ms apart agree, the DOM has stopped
    // adding fields.
    let lastCount = -1;
    for (let i = 0; i < 5; i++) {
      const count = await page
        .locator('input:not([type="hidden"]), textarea, [contenteditable="true"]')
        .count()
        .catch(() => 0);
      if (count === lastCount) break;
      lastCount = count;
      await page.waitForTimeout(800);
    }

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

  // See the class-level comment for the full story. ctx.application.sourceUrl
  // here is the PUBLIC www.collective.work/jobs/... page (no jobId). Returns
  // 'opened' with `page` already sitting on the real opportunities/overview
  // URL, ready for the exact same form-handling code as the direct-jobId path.
  private async openFormViaPublicListing(page: Page, ctx: ApplyContext): Promise<'opened' | 'not-found' | 'session-expired'> {
    await page.goto(ctx.application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await dismissCookieBanner(page);

    if (SESSION_CHECKS.collective_work.isLoginWallVisible && (await SESSION_CHECKS.collective_work.isLoginWallVisible(page))) {
      return 'session-expired';
    }

    // Pull BOTH the real internal project id and its exact rendered title
    // from this page's own Next.js data -- ctx.application.jobTitle is the
    // ORIGINAL source's title (Adzuna/HelloWork), which confirmed live does
    // not always match Collective Work's own title string for the same
    // posting verbatim (e.g. a trailing "- Freelance" appended twice by the
    // aggregator), so it can't be trusted for an exact-text click locator.
    const project = await page
      .evaluate(() => {
        try {
          const doc: any = (globalThis as any).document;
          const el = doc.getElementById('__NEXT_DATA__');
          if (!el) return null;
          const data = JSON.parse(el.textContent || '{}');
          const p = data?.props?.pageProps?.project;
          return p?.id && p?.name ? { id: p.id as string, name: p.name as string } : null;
        } catch {
          return null;
        }
      })
      .catch(() => null);
    if (!project) return 'not-found';

    await page
      .goto(`https://app.collective.work/talent/jobs?jobId=${project.id}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => {});
    await page.waitForTimeout(3000);

    const titleLoc = page.getByText(project.name, { exact: true }).first();
    const titleVisible = await titleLoc.isVisible({ timeout: 8000 }).catch(() => false);
    if (!titleVisible) return 'not-found';
    await titleLoc.scrollIntoViewIfNeeded().catch(() => {});
    // A real mouse click here, not a JS-dispatched one -- confirmed live
    // the listing's React router only reacts to a genuine click event.
    await titleLoc.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // The panel renders MULTIPLE elements accessibly named "Postuler" --
    // confirmed live via real bounding boxes: a small 32x32 icon-only
    // button (a quick-action of some kind, not the real apply flow -- it
    // clicks without error but leaves the URL unchanged) alongside the
    // actual ~80px-wide text button. An off-screen/zero-size sticky-header
    // duplicate has also been seen separately. A loose "any decent-sized,
    // on-screen match" filter picks whichever comes first in DOM order,
    // which is NOT reliably the real one (confirmed live: it grabbed the
    // icon button here). The real "Postuler" is consistently the WIDEST
    // on-screen match -- it has to fit the word -- so pick that one
    // specifically instead of the first one over a low size floor. Click
    // through Playwright's own locator.click() rather than a one-shot
    // page.mouse.click() at pre-computed coordinates -- confirmed live the
    // coordinate approach can also miss (the panel can still be settling/
    // animating in right after it opens) -- locator.click() re-verifies
    // position and retries immediately before actually clicking.
    const postulerButtons = page.getByRole('button', { name: /^postuler$/i });
    const count = await postulerButtons.count();
    let realIndex = -1;
    let widest = 0;
    for (let i = 0; i < count; i++) {
      const box = await postulerButtons.nth(i).boundingBox().catch(() => null);
      if (box && box.width > 40 && box.height > 10 && box.width > widest) {
        widest = box.width;
        realIndex = i;
      }
    }
    if (realIndex === -1) return 'not-found';

    await postulerButtons.nth(realIndex).click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3000);

    return /\/opportunities\//.test(page.url()) ? 'opened' : 'not-found';
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
        // Same fix as SessionHealthService's collective_work branch: a
        // single instant isVisible() right after a fixed sleep doesn't
        // retry if the SPA hasn't rendered yet under real load, even
        // though the same page loads reliably fast in isolation.
        const fieldsReady = await emailField
          .waitFor({ state: 'visible', timeout: 8000 })
          .then(() => passField.waitFor({ state: 'visible', timeout: 8000 }))
          .then(() => true)
          .catch(() => false);
        if (fieldsReady) {
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
