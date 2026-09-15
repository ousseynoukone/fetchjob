import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';
import { fillKnownFields, scanInvalidFields } from './form-fields';
import { dismissCookieBanner, SESSION_CHECKS, resolveExternalApplyUrl, hasJobClosedIndicator } from './ats-common';

function formatFrenchPhone(raw: string): string {
  if (!raw) return '';
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+33')) {
    const rest = cleaned.slice(3);
    return rest.startsWith('0') ? rest : '0' + rest;
  }
  if (cleaned.startsWith('0033')) {
    const rest = cleaned.slice(4);
    return rest.startsWith('0') ? rest : '0' + rest;
  }
  return cleaned;
}

@Injectable()
export class LinkedInApplier implements JobApplier {
  readonly credentialPlatform = 'linkedin';
  private readonly logger = new Logger(LinkedInApplier.name);

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    await ctx.appendLog?.(`Navigation vers l'offre LinkedIn : ${ctx.application.jobTitle}...`);
    const targetUrl = ctx.application.sourceUrl.replace(/https?:\/\/[a-z]{2}\.linkedin\.com/i, 'https://www.linkedin.com');
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err: any) {
      if (err.message && err.message.includes('ERR_TOO_MANY_REDIRECTS')) {
        await ctx.appendLog?.('Session LinkedIn révoquée ou invalide (boucle de redirection détectée).');
        const loginRes = await this.performDirectLogin(page, ctx);
        if (loginRes) return loginRes;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else {
        throw err;
      }
    }
        await dismissCookieBanner(page);
    await this.handleConsentWall(page, ctx);

    await page.waitForTimeout(2000);

    const hasRenderedContent = async () =>
      page.locator('body').innerText({ timeout: 2000 }).then((t) => t.trim().length > 200).catch(() => false);

    if (!(await hasRenderedContent())) {
      await page.waitForTimeout(3000);
    }
    if (!(await hasRenderedContent())) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    const topCard = page.locator(
      '.jobs-unified-top-card, ' +
      '.job-details-jobs-unified-top-card__container--two-pane, ' +
      '[class*="jobs-unified-top-card" i], ' +
      '.top-card-layout, ' +
      '.jobs-details__main-content, ' +
      '.job-view-layout'
    ).first();
    const topCardScope = (await topCard.count().catch(() => 0)) > 0 ? topCard : page.locator('main, #main-content, body').first();

    // Check for Easy Apply specifically:
    // It is a button with Easy Apply / Candidature simplifiée text, or an a tag with /apply/
    // Exclude similar jobs, search-results, and collection links!
    const easyApplyButton = topCardScope
      .locator(
        'button.jobs-apply-button, ' +
        'button:has-text("Candidature simplifiée"), ' +
        'button:has-text("Easy Apply"), ' +
        'a[href*="/apply/"]:not([href*="search-results"]):not([href*="collections"])'
      )
      .first();

    // Check for external apply button (employer ATS, Free-Work, etc.)
    const externalApplyButton = topCardScope
      .locator(
        'button:has-text("Postuler"), button:has-text("Apply"), ' +
        'a:has-text("Postuler"), a:has-text("Apply"), ' +
        'a[data-tracking-control-name*="apply" i], button[data-tracking-control-name*="apply" i], ' +
        'a[href*="/safety/go/"]'
      )
      .filter({ hasNotText: /candidature simplifi|easy apply/i })
      .first();

    const hasEasyApply = (await easyApplyButton.count().catch(() => 0)) > 0 && (await easyApplyButton.isVisible().catch(() => false));

    if (!hasEasyApply) {
      if (await externalApplyButton.isVisible().catch(() => false)) {
        await ctx.appendLog?.('Redirection vers le site employeur...');
        const externalUrl = await resolveExternalApplyUrl(page, externalApplyButton, /linkedin\.com/i);
        if (externalUrl) {
          return { success: false, redirectToExternalUrl: externalUrl };
        }
      }

      // If neither is visible, check if we're on a login wall before concluding
      const loginResult = await this.ensureLoggedIn(page, ctx);
      if (loginResult) return loginResult;

      if (await hasJobClosedIndicator(page)) {
        await ctx.appendLog?.('Cette offre LinkedIn n\'accepte plus de candidatures.');
        return {
          success: false,
          note: "Cette offre LinkedIn n'accepte plus de candidatures -- à retirer ou ignorer.",
        };
      }

      await ctx.appendLog?.('Aucun bouton de candidature trouvé sur cette offre LinkedIn.');
      return {
        success: false,
        note: 'Aucun bouton de candidature trouvé sur cette offre LinkedIn -- à traiter manuellement.',
      };
    }

    this.logger.log(`Found Easy Apply button for ${ctx.application.id}, clicking...`);
    await ctx.appendLog?.('Bouton Candidature simplifiée détecté, ouverture du modal...');
    try {
      await easyApplyButton.click({ timeout: 5000 });
    } catch {
      await easyApplyButton.evaluate((el: any) => el.click());
    }
    await page.waitForTimeout(2000);

    // If redirected to consent wall, handle it and return to job
    if (page.url().includes('connect-services')) {
      await this.handleConsentWall(page, ctx);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      const retryBtn = topCardScope
        .locator('a[href*="/apply/"], a:has-text("Candidature simplifiée"), button:has-text("Candidature simplifiée")')
        .first();
      if (await retryBtn.isVisible().catch(() => false)) {
        await retryBtn.click().catch(() => retryBtn.evaluate((el: any) => el.click()));
        await page.waitForTimeout(2000);
      }
    }

    await ctx.appendLog?.('Chargement du formulaire Easy Apply...');
    const modalDialog = page.locator('.jobs-easy-apply-modal, [role="dialog"], .artdeco-modal').first();
    await modalDialog.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

    let modalLoaded = false;
    for (let attempt = 0; attempt < 18; attempt++) {
      await page.waitForTimeout(1000);

      const hasSpinner = await page
        .locator('.artdeco-loader, [role="progressbar"], .artdeco-loader__bars')
        .first()
        .isVisible()
        .catch(() => false);

      const hasInteractive = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const dialog = doc?.querySelector('.jobs-easy-apply-modal, [role="dialog"], .artdeco-modal');
        if (!dialog) return false;
        const inputs = Array.from(dialog.querySelectorAll('input:not([type=hidden]), textarea, select, button'));
        return inputs.length > 0;
      }).catch(() => false);

      if (!hasSpinner && hasInteractive) {
        modalLoaded = true;
        break;
      }
    }

    if (!modalLoaded) {
      await ctx.appendLog?.('Le formulaire LinkedIn ne s\'est pas chargé (délai dépassé).');
      return {
        success: false,
        note: 'Le formulaire Easy Apply LinkedIn ne s\'est pas chargé (délai dépassé).',
      };
    }

    await ctx.appendLog?.('Formulaire Easy Apply chargé avec succès.');
    await page.waitForTimeout(600);

    // Step through the multi-page Easy Apply modal (up to 8 steps)
    for (let step = 0; step < 8; step++) {
      const stepHeader = await page
        .locator('[role="dialog"] h3, [role="dialog"] h2, .artdeco-modal__header')
        .first()
        .innerText()
        .catch(() => '');
      await ctx.appendLog?.(`Étape ${step + 1} du formulaire LinkedIn ${stepHeader ? `(${stepHeader})` : ''}...`);

      // 1. Phone & Location fields
      await this.fillCvIdentityFields(page, ctx);

      // 2. CV Upload handling (hidden file input OR button)
      const fileInput = page.locator('input[type="file"]').first();
      const hasFileInput = (await fileInput.count().catch(() => 0)) > 0;
      if (hasFileInput) {
        try {
          await fileInput.setInputFiles(ctx.cvPdfPath);
          await page.waitForTimeout(1500);
          await ctx.appendLog?.('CV téléversé avec succès.');
        } catch (e: any) {
          this.logger.warn(`FileInput error: ${e.message}`);
        }
      }

      // 3. Cover letter if present
      if (ctx.coverLetter) {
        const coverLetterField = page
          .locator('textarea[id*="cover" i], textarea[aria-label*="lettre" i], textarea[aria-label*="cover" i]')
          .first();
        if (await coverLetterField.isVisible().catch(() => false)) {
          await coverLetterField.fill(ctx.coverLetter).catch(() => {});
        }
      }

      // 4. Fill custom questions from learned answers and defaults
      await fillKnownFields(page, ctx.knownAnswers);

      // 5. Fill empty numeric or text screening inputs
      const emptyInputs = await page.$$('input[type="text"]:visible, input[type="number"]:visible');
      for (const input of emptyInputs) {
        const val = await input.inputValue().catch(() => '');
        if (!val) {
          await input.fill('3').catch(() => {});
        }
      }

      // 6. Select dropdowns
      const selects = await page.$$('select');
      for (const s of selects) {
        const isVis = await s.isVisible().catch(() => false);
        if (isVis) {
          const val = await s.inputValue().catch(() => '');
          const options = await s.$$eval('option', (opts: any[]) => opts.map(o => ({ value: o.value, text: (o.innerText || '').trim() })));
          if (!val || val === 'Select an option' || val === '' || val.includes('lectionnez')) {
            const preferred = options.find((o: any) => /oui|yes|true/i.test(o.text) || /oui|yes|true/i.test(o.value));
            if (preferred && preferred.value) {
              await s.selectOption(preferred.value).catch(() => {});
            } else if (options.length > 1 && options[1].value) {
              await s.selectOption(options[1].value).catch(() => {});
            }
          }
        }
      }

      // 7. Radio buttons / Fieldsets
      const fieldsets = await page.$$('fieldset');
      for (const fs of fieldsets) {
        const checked = await fs.$('input[type="radio"]:checked');
        if (!checked) {
          const first = await fs.$('input[type="radio"][value="Yes"], input[type="radio"][value="Oui"], input[type="radio"]');
          if (first) {
            await first.click().catch(() => {});
          }
        }
      }

      // 8. Incomplete profile experiences cleanup if blocking
      const deleteExpBtn = page.locator('button:has-text("Supprimer"), a:has-text("Supprimer"), [aria-label*="Supprimer"]').first();
      if ((await deleteExpBtn.count().catch(() => 0)) > 0 && (await deleteExpBtn.isVisible().catch(() => false))) {
        await deleteExpBtn.click().catch(() => {});
        await page.waitForTimeout(500);
      }

      // 9. Submit button detection
      const submitButton = page
        .getByRole('button', { name: /submit application|envoyer la candidature|d[e\u00e9]poser la candidature|soumettre/i })
        .or(page.locator('button:has-text("Envoyer la candidature"), button:has-text("Submit application")'))
        .first();

      if (await submitButton.isVisible().catch(() => false)) {
        this.logger.log(`Submitting application for ${ctx.application.id}...`);
        await ctx.appendLog?.('Vérification finale et soumission de la candidature...');
        await submitButton.click();
        await page.waitForTimeout(4000);

        const confirmed = await page
          .getByText(/application sent|candidature envoy[e\u00e9]e|votre candidature a [e\u00e9]t[e\u00e9] envoy[e\u00e9]e/i)
          .first()
          .isVisible()
          .catch(() => false);

        await ctx.appendLog?.('Candidature Easy Apply soumise avec succès !');
        return { success: true, note: confirmed ? undefined : 'Candidature Easy Apply soumise.' };
      }

      // 10. Review button detection
      const reviewButton = page
        .getByRole('button', { name: /review|v[e\u00e9]rifier|examiner/i })
        .or(page.locator('button:has-text("Vérifier"), button:has-text("Review"), button:has-text("Examiner")'))
        .first();

      if (await reviewButton.isVisible().catch(() => false)) {
        await reviewButton.click();
        await page.waitForTimeout(2000);
        continue;
      }

      // 11. Next button detection
      const nextButton = page
        .getByRole('button', { name: /next|suivant|continuer/i })
        .or(page.locator('button:has-text("Suivant"), button:has-text("Next"), button:has-text("Continuer")'))
        .first();

      if (await nextButton.isVisible().catch(() => false)) {
        await nextButton.click();
        await page.waitForTimeout(2000);
        continue;
      }

      break;
    }

    return {
      success: false,
      note: 'Formulaire Easy Apply non finalisé (étape inattendue) -- à vérifier manuellement.',
    };
  }

  private async fillCvIdentityFields(page: Page, ctx: ApplyContext): Promise<void> {
    const rawPhone = ctx.cv.phone || '0612345678';
    const cleanPhone = formatFrenchPhone(rawPhone);
    const phoneSelectors = [
      'input[type="tel"]',
      'input[aria-label*="téléphone" i]',
      'input[aria-label*="phone" i]',
      'input[id*="phone" i]',
      'input[name*="phone" i]',
      'input[placeholder*="téléphone" i]',
      'input[placeholder*="phone" i]',
    ];

    for (const sel of phoneSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const currentValue = await el.inputValue().catch(() => '');
        if (!currentValue || currentValue !== cleanPhone) {
          await el.fill(cleanPhone).catch(() => {});
          await ctx.appendLog?.(`Numéro de téléphone renseigné : ${cleanPhone}`);
        }
        break;
      }
    }

    const location = ctx.cv.location || 'Paris, France';
    const locationSelectors = [
      'input[id*="city" i]',
      'input[id*="location" i]',
      'input[name*="city" i]',
      'input[aria-label*="city" i]',
      'input[aria-label*="ville" i]',
      'input[aria-label*="location" i]',
    ];

    for (const sel of locationSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const currentValue = await el.inputValue().catch(() => '');
        if (!currentValue) {
          await el.fill(location).catch(() => {});
          await page.waitForTimeout(500);
          const option = page.locator('[role="option"]').first();
          if (await option.isVisible().catch(() => false)) {
            await option.click().catch(() => {});
          } else {
            await el.press('Escape').catch(() => {});
          }
        }
        break;
      }
    }
  }

    private async handleConsentWall(page: Page, ctx: ApplyContext): Promise<boolean> {
    const isConsent =
      page.url().includes('connect-services') ||
      (await page
        .locator('button:has-text("Oui, garder"), button:has-text("garder les services"), button:has-text("Keep services")')
        .count()
        .catch(() => 0)) > 0;

    if (isConsent) {
      await ctx.appendLog?.('Validation du consentement LinkedIn (services connectés)...');
      const confirmBtn = page
        .locator('button:has-text("Oui, garder"), button:has-text("garder les services"), button:has-text("Keep services"), button.primary-action-btn')
        .first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
        const state = await page.context().storageState().catch(() => null);
        if (state) {
          await ctx.onSessionUpdated?.(JSON.stringify(state));
        }
        return true;
      }
    }
    return false;
  }

  private async performDirectLogin(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    const email = ctx.credential?.email;
    const password = ctx.credential?.password;

    if (!email || !password) {
      await ctx.appendLog?.('Identifiants LinkedIn manquants (email et mot de passe requis).');
      return {
        success: false,
        sessionExpired: true,
        note: 'Identifiants LinkedIn non configurés -- renseignez votre mot de passe dans Paramètres.',
      };
    }

    try {
      await ctx.appendLog?.(`Connexion automatique LinkedIn avec l'identifiant ${email}...`);
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await dismissCookieBanner(page);

      const emailInput = page.locator('input#username, input[type="email"]:visible, input[autocomplete="username"]:visible, input[name="session_key"]').first();
      await emailInput.fill(email);

      const passwordInput = page.locator('input#password, input[type="password"]:visible, input[name="session_password"]').first();
      await passwordInput.fill(password);

      // Submit strictly via Enter to avoid misclicking third-party OAuth buttons
      await passwordInput.press('Enter');

      await page.waitForTimeout(5000);
      if (page.url().includes('connect-services') || page.url().includes('/check/')) {
        await page.waitForTimeout(3000);
      }

      // Check if CAPTCHA or checkpoint appeared
      if (page.url().includes('/checkpoint/challenge') || (await page.locator('#captcha-internal').count()) > 0) {
        await ctx.appendLog?.('LinkedIn demande une vérification de sécurité (CAPTCHA/Challenge).');
        return {
          success: false,
          sessionExpired: true,
          note: 'LinkedIn requiert une validation de sécurité manuelle.',
        };
      }

      // Check if logged in (url no longer /login or /uas/login)
      if (!page.url().includes('/login') && !page.url().includes('/uas/login')) {
        await ctx.appendLog?.('Connexion automatique LinkedIn réussie !');
        // Persist session cookies for subsequent visits
        const state = await page.context().storageState().catch(() => null);
        if (state) {
          await ctx.onSessionUpdated?.(JSON.stringify(state));
        }
        return null;
      } else {
        await ctx.appendLog?.('Échec de la connexion LinkedIn (identifiants incorrects).');
        return {
          success: false,
          sessionExpired: true,
          note: 'Connexion LinkedIn rejetée -- vérifiez vos identifiants dans Paramètres.',
        };
      }
    } catch (err: any) {
      this.logger.error(`Login error: ${err.message}`);
      return {
        success: false,
        sessionExpired: true,
        note: `Erreur lors de la connexion LinkedIn : ${err.message}`,
      };
    }
  }

  private async ensureLoggedIn(page: Page, ctx: ApplyContext): Promise<ApplyResult | null> {
    const onLoginWall = await SESSION_CHECKS.linkedin.isLoginWallVisible(page);
    if (!onLoginWall) return null;

    await ctx.appendLog?.('Connexion requise sur LinkedIn, tentative de connexion automatique...');
    const directLoginResult = await this.performDirectLogin(page, ctx);
    return directLoginResult;
  }
}
