import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Page } from 'playwright';
import { PrismaService } from '../common/prisma.service';
import { PlatformCredentialsService } from '../platform-credentials/platform-credentials.service';
import { SupportedPlatform } from '../platform-credentials/dto/upsert-credential.dto';
import { BrowserSessionService } from '../auto-apply/browser-session.service';
import { SESSION_CHECKS, blockHeavyResources, dismissCookieBanner, handleUniversalEmailOtp, humanFill, humanClick } from '../auto-apply/appliers/ats-common';
import { REMOTE_LOGIN_URLS } from '../platform-credentials/remote-login.service';
import { GmailOtpService } from '../common/gmail-otp.service';

const LINKEDIN_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class SessionHealthService implements OnModuleInit {
  private readonly logger = new Logger(SessionHealthService.name);
  // In-process only (resets on restart, which is acceptable): when the last
  // automatic LinkedIn login failed. See LINKEDIN_RETRY_COOLDOWN_MS.
  private lastLinkedInLoginFailure = 0;

  constructor(
    private prisma: PrismaService,
    private credentials: PlatformCredentialsService,
    private browserSession: BrowserSessionService,
    private gmailOtp: GmailOtpService,
  ) {}

  onModuleInit() {
    // Check sessions 30s after boot so any sessions expired during downtime are immediately restored
    setTimeout(() => {
      this.logger.log('Running post-boot session health check...');
      this.run().catch((err) => this.logger.warn(`Startup session check error: ${err.message}`));
    }, 30000);
  }

  // Multi-day cookies with declared expiry are refreshed ahead of time with an 8h margin
  private static readonly REFRESH_MARGIN_MS = 8 * 60 * 60 * 1000;

  // Sliding sessions (France Travail, HelloWork, Indeed, WTTJ) terminate idle sessions
  // on the server within 30 to 60 minutes of inactivity. Touching them every 20-25 minutes
  // extends the sliding window permanently so the user never has to reconnect manually every hour.
  private static readonly SLIDING_WINDOW_KEEP_ALIVE_MS = 25 * 60 * 1000;

  // Cron schedule: runs every 20 minutes to keep sliding sessions active
  @Cron('*/20 * * * *')
  async checkAll() {
    try {
      // Small human jitter (15s to 90s) to avoid fixed-clock machine signatures
      const jitterMs = Math.floor((15 + Math.random() * 75) * 1000);
      await new Promise((resolve) => setTimeout(resolve, jitterMs));

      await this.run();
    } catch (error: any) {
      this.logger.warn(`Session health check failed: ${error.message}`);
    }
  }

  // One sweep at a time. Confirmed live: the post-boot check, the 20-minute
  // cron and a manual check-now all fired within seconds of each other and
  // ran concurrently through the same browser -- every platform visited two
  // or three times back to back, which is both wasted work and exactly the
  // burst of repeated automated traffic anti-bot systems score against.
  private sweepInProgress = false;

  async run(force = false): Promise<{ platform: string; status: 'refreshed' | 'expired' | 'error' | 'skipped' }[]> {
    if (this.sweepInProgress) {
      this.logger.log('Session health sweep already in progress — skipping this trigger.');
      return [];
    }
    this.sweepInProgress = true;
    try {
      return await this.sweep(force);
    } finally {
      this.sweepInProgress = false;
    }
  }

  private async sweep(force: boolean): Promise<{ platform: string; status: 'refreshed' | 'expired' | 'error' | 'skipped' }[]> {
    const allCreds = await this.prisma.platformCredential.findMany();
    const credentials = allCreds.filter((c) => c.sessionStateEncrypted || c.emailEncrypted);

    const results: { platform: string; status: 'refreshed' | 'expired' | 'error' | 'skipped' }[] = [];
    for (const credential of credentials) {
      const platform = credential.platform as SupportedPlatform;
      if (platform === 'gmail') continue;

      if (!force) {
        const hasKnownError = !!credential.lastLoginError;
        if (!hasKnownError) {
          const due = await this.isRefreshDue(credential.userId, platform, credential.lastLoginAt).catch(() => true);
          if (!due) {
            results.push({ platform, status: 'skipped' });
            continue;
          }
        }
      }

      const status = await this.checkOne(credential.userId, platform).catch((error: any) => {
        this.logger.warn(`Session health check failed for ${platform}: ${error.message}`);
        return 'error' as const;
      });
      results.push({ platform, status });
      // Pause between platforms to mimic human browsing behavior
      await this.browserSession.randomDelay(10000, 25000);
    }
    return results;
  }

  private async isRefreshDue(
    userId: string,
    platform: SupportedPlatform,
    lastRefreshedAt: Date | null,
  ): Promise<boolean> {
    const { sessionState, password } = await this.credentials.getDecrypted(userId, platform);
    if (!sessionState) return !!password;

    // Check if an explicit authentication cookie is expiring soon
    const earliestExpiryMs = this.earliestAuthCookieExpiryMs(sessionState);
    if (earliestExpiryMs !== null) {
      if (earliestExpiryMs - Date.now() <= SessionHealthService.REFRESH_MARGIN_MS) {
        return true;
      }
    }

    // Sliding window sessions: keep alive if last touched >= 25 minutes ago
    if (!lastRefreshedAt) return true;
    return Date.now() - lastRefreshedAt.getTime() >= SessionHealthService.SLIDING_WINDOW_KEEP_ALIVE_MS;
  }

  // Filters out third-party analytics and tracking cookies (e.g. Google Analytics _ga expiring in 2 years)
  // so we only inspect real authentication cookies.
  private earliestAuthCookieExpiryMs(sessionStateJson: string): number | null {
    try {
      let parsed = JSON.parse(sessionStateJson);
      while (typeof parsed === 'string') parsed = JSON.parse(parsed);
      const cookies = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];

      const TRACKING_COOKIE_NAMES =
        /^_ga|_gid|_gat|_pk_|_cl|tc_priv|tc_vars|eulerian|datadog|clarity|cf_clearance|__cf_bm|optimizely|amplitude/i;

      let earliest: number | null = null;
      for (const cookie of cookies) {
        if (!cookie?.name || TRACKING_COOKIE_NAMES.test(cookie.name)) continue;
        const expires =
          typeof cookie?.expires === 'number'
            ? cookie.expires
            : typeof cookie?.expirationDate === 'number'
              ? cookie.expirationDate
              : -1;
        if (expires <= 0) continue;
        const expiresMs = expires * 1000;
        if (earliest === null || expiresMs < earliest) earliest = expiresMs;
      }
      return earliest;
    } catch {
      return null;
    }
  }

  private async checkOne(userId: string, platform: SupportedPlatform): Promise<'refreshed' | 'expired'> {
    const check = SESSION_CHECKS[platform];
    if (!check) return 'expired';

    const cred = await this.credentials.getDecrypted(userId, platform);
    if (!cred.sessionState) {
      if (
        platform !== 'linkedin' &&
        cred.email &&
        cred.password &&
        cred.email !== '(session importée)' &&
        cred.email !== '(connecté via navigateur intégré)'
      ) {
        this.logger.log(`No active session cookies for ${platform} — attempting background login with stored credentials...`);
        const context = await this.browserSession.acquireContext(null, platform);
        try {
          await blockHeavyResources(context);
          const page = await context.newPage();
          const relogged = await this.attemptBackgroundLogin(page, platform, cred.email, cred.password, userId);
          if (relogged) {
            const freshState = await context.storageState();
            await this.credentials.saveSessionState(userId, platform, JSON.stringify(freshState));
            await this.browserSession.persistContextCookies(context, platform).catch(() => {});
            this.logger.log(`Session automatically established and stored for ${platform}`);
            return 'refreshed';
          }
        } finally {
          await this.browserSession.releaseContext(context, platform);
        }
      }
      this.logger.log(`No usable session for ${platform} and no stored credentials to re-login with — left as expired.`);
      return 'expired';
    }

    // Pass platform so BrowserSessionService applies site-specific fingerprints and cookie caches
    const context = await this.browserSession.acquireContext(cred.sessionState, platform);
    try {
      await blockHeavyResources(context);
      const page = await context.newPage();
      let onLoginWall: boolean;
      try {
        await page.goto(check.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await dismissCookieBanner(page).catch(() => {});
        await page.waitForTimeout(2000 + Math.random() * 2000);

        // Simulate natural human glance and smooth scrolling
        await page
          .evaluate(() => {
            const win = (globalThis as any).window;
            if (win && win.scrollBy) {
              win.scrollBy({ top: 250 + Math.random() * 200, behavior: 'smooth' });
            }
          })
          .catch(() => {});
        await page.waitForTimeout(2000 + Math.random() * 1500);

        onLoginWall = await check.isLoginWallVisible(page);
      } catch (err: any) {
        if (!/ERR_TOO_MANY_REDIRECTS/.test(err?.message || '')) throw err;
        // A redirect loop from the stored cookies is not a transient network
        // error -- it's the platform rejecting that cookie set outright, and
        // the set stays unusable until replaced. Confirmed live on LinkedIn:
        // left as an escaping exception, this surfaced as "check failed",
        // recorded nothing, and every 20-minute sweep failed identically
        // forever while the UI still showed the session as fine. Routed
        // into the expired-session branch below instead, with the bad
        // cookies cleared first so the re-login (for platforms that allow
        // it) starts from a clean login page rather than the same loop.
        this.logger.warn(`Stored ${platform} session produced a redirect loop — treating it as expired.`);
        await context.clearCookies().catch(() => {});
        onLoginWall = true;
      }

      if (onLoginWall) {
        // If credentials (email + password) are available, attempt automatic background re-login
        // so the user does NOT have to open the manual remote browser repeatedly!
        // LinkedIn used to be excluded on the grounds that an automated password login
        // triggers security checkpoints -- a real one had been seen once (see the
        // checkpoint note on SESSION_CHECKS.linkedin). Tested live through the host
        // Chrome with the stored cookies: LinkedIn showed its "Bon retour parmi nous"
        // remembered-account page (password only), the login went straight to /feed/
        // with no checkpoint. It is attempted again, but never forced past a checkpoint,
        // and never retried for LINKEDIN_RETRY_COOLDOWN_MS after a failure: repeated
        // failed logins are a signal in themselves.
        if (
          (platform !== 'linkedin' || Date.now() - this.lastLinkedInLoginFailure > LINKEDIN_RETRY_COOLDOWN_MS) &&
          cred.email &&
          (cred.password || platform === 'indeed') &&
          cred.email !== '(session importée)' &&
          cred.email !== '(connecté via navigateur intégré)'
        ) {
          this.logger.log(`Session expired for ${platform} — attempting automatic background re-login...`);
          const relogged = await this.attemptBackgroundLogin(page, platform, cred.email, cred.password || '', userId);
          if (relogged) {
            const freshState = await context.storageState();
            await this.credentials.saveSessionState(userId, platform, JSON.stringify(freshState));
            await this.browserSession.persistContextCookies(context, platform).catch(() => {});
            this.logger.log(`Session automatically restored and refreshed for ${platform}`);
            return 'refreshed';
          }
          if (platform === 'linkedin') this.lastLinkedInLoginFailure = Date.now();
        }

        this.logger.warn(`Session expired for ${platform} — needs a reconnect from Comptes.`);
        await this.credentials.recordSessionExpired(userId, platform);
        return 'expired';
      }

      const freshState = await context.storageState();
      await this.credentials.saveSessionState(userId, platform, JSON.stringify(freshState));
      await this.browserSession.persistContextCookies(context, platform).catch(() => {});
      this.logger.log(`Session successfully refreshed and kept alive for ${platform}`);
      return 'refreshed';
    } finally {
      await this.browserSession.releaseContext(context, platform);
    }
  }

  /**
   * Stealth background re-authentication when a session has expired but the user
   * already has valid credentials stored. Prevents requiring manual user reconnection.
   */
  private async attemptBackgroundLogin(
    page: Page,
    platform: SupportedPlatform,
    email: string,
    pass: string,
    userId: string,
  ): Promise<boolean> {
    try {
      const loginUrl = REMOTE_LOGIN_URLS[platform];
      if (!loginUrl) return false;

      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await dismissCookieBanner(page).catch(() => {});
      await page.waitForTimeout(1500 + Math.random() * 1000);

      if (platform === 'france_travail') {
        const idField = page.locator('#identifiant, input[name="identifiant"]').first();
        await idField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        await dismissCookieBanner(page).catch(() => {});

        if (await idField.isVisible().catch(() => false)) {
          await idField.fill(email);
          const passField = page.locator('#password, input[name="password"], input[type="password"]').first();
          if (await passField.isVisible().catch(() => false)) {
            await passField.fill(pass);
          }
          const loginBtn = page.locator('#submit, #boutonConnexion, #boutonSeConnecter, button:has-text("Se connecter"), button[type="submit"]').first();
          if (await loginBtn.isVisible().catch(() => false)) {
            await loginBtn.click({ force: true }).catch(() => loginBtn.click());
          } else {
            await idField.press('Enter');
          }
          await page.waitForTimeout(5000);
        }

        // Always check for email OTP / 2FA challenge and solve it via Gmail
        await handleUniversalEmailOtp(page, 'france_travail', userId, this.gmailOtp, this.logger);

        return !await SESSION_CHECKS.france_travail.isLoginWallVisible(page);
      }

      if (platform === 'apec') {
        const emailField = page.locator('#emailid, input[name="emailid"], input[type="email"]').first();
        await emailField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        await dismissCookieBanner(page).catch(() => {});

        const passField = page.locator('#password, input[name="password"], input[type="password"]').first();
        if ((await emailField.isVisible().catch(() => false)) && (await passField.isVisible().catch(() => false))) {
          await emailField.fill(email);
          await passField.fill(pass);
          const submitBtn = page.locator('button.popin-btn-primary, button:has-text("Se connecter"), button[type="submit"], .btn-connexion').first();
          if (await submitBtn.isVisible().catch(() => false)) {
            await submitBtn.click();
          } else {
            await passField.press('Enter');
          }
          await page.waitForTimeout(5000);

          // Check if APEC prompted for 2FA / email code
          await handleUniversalEmailOtp(page, 'apec', userId, this.gmailOtp, this.logger);

          return !await SESSION_CHECKS.apec.isLoginWallVisible(page);
        }
      }

      if (platform === 'welcome_to_the_jungle') {
        const emailField = page.locator('input[name="email"], input[type="email"]').first();
        const passField = page.locator('input[name="password"], input[type="password"]').first();
        if ((await emailField.isVisible().catch(() => false)) && (await passField.isVisible().catch(() => false))) {
          await emailField.fill(email);
          await passField.fill(pass);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(4000);

          await handleUniversalEmailOtp(page, 'welcome_to_the_jungle', userId, this.gmailOtp, this.logger);

          return !await SESSION_CHECKS.welcome_to_the_jungle.isLoginWallVisible(page);
        }
      }

      if (platform === 'hellowork') {
        const emailField = page.locator('input[name="email2"], input[name="email"]').first();
        const passField = page.locator('input[type="password"]').first();
        if ((await emailField.isVisible().catch(() => false)) && (await passField.isVisible().catch(() => false))) {
          await emailField.fill(email);
          await passField.fill(pass);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(4000);

          await handleUniversalEmailOtp(page, 'hellowork', userId, this.gmailOtp, this.logger);

          return !await SESSION_CHECKS.hellowork.isLoginWallVisible(page);
        }
      }


      // Confirmed live: the stored Free-Work session's jwt cookies had
      // expired hours earlier and its refresh_token was rejected by the
      // server (from the host Chrome as well as the container -- not a
      // browser binding), yet a plain login with the stored credentials
      // works and yields a session that replays fine. This platform had no
      // handler here, so every expiry ended in "needs a reconnect from
      // Comptes" although the credentials were valid. The button name is
      // matched exactly: the same page also offers "Se connecter avec
      // LinkedIn" / "Se connecter avec Google".
      if (platform === 'free_work') {
        const emailField = page.locator('input[type="email"], input[name*="email" i]').first();
        const passField = page.locator('input[type="password"]').first();
        await passField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        if ((await emailField.isVisible().catch(() => false)) && (await passField.isVisible().catch(() => false))) {
          await humanFill(emailField, email);
          await humanFill(passField, pass);
          const loginBtn = page.getByRole('button', { name: /^se connecter$/i }).first();
          if (await loginBtn.isVisible().catch(() => false)) {
            await humanClick(page, loginBtn).catch(() => loginBtn.click().catch(() => {}));
          } else {
            await passField.press('Enter');
          }
          // Poll rather than one fixed wait: the login POST and redirect
          // take a variable few seconds (a fixed 2s read the still-open
          // form as a rejection).
          for (let i = 0; i < 10; i++) {
            await page.waitForTimeout(1000);
            if (!(await page.locator('input[type="password"]:visible').first().isVisible().catch(() => false))) break;
          }
          return !await SESSION_CHECKS.free_work.isLoginWallVisible(page);
        }
      }

      if (platform === 'linkedin') {
        // Two layouts, confirmed live: a returning browser gets "Bon retour
        // parmi nous" (the remembered account, password field only, ids
        // generated per render so no #password); an unknown one gets the full
        // email + password form.
        const passField = page.locator('input[type="password"]:visible').first();
        await passField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        if (!(await passField.isVisible().catch(() => false))) return false;
        const userField = page.locator('input[type="email"]:visible, input[type="text"]:visible, input#username, input[name="session_key"]').first();
        if (await userField.isVisible().catch(() => false)) await humanFill(userField, email);
        await humanFill(passField, pass);
        // Exact name: the same page offers "S'identifier avec Apple" and
        // "Continuer avec Google".
        const signIn = page.getByRole('button', { name: /^(s.?identifier|se connecter|sign in)$/i }).first();
        if (await signIn.isVisible().catch(() => false)) {
          await humanClick(page, signIn).catch(() => signIn.click().catch(() => {}));
        } else {
          await passField.press('Enter');
        }
        for (let i = 0; i < 20; i++) {
          await page.waitForTimeout(1000);
          if (!/\/login|\/uas\/login/.test(page.url())) break;
        }
        await page.waitForTimeout(2000);
        // A checkpoint is a security wall, not something to push through.
        if (/\/checkpoint\//.test(page.url())) {
          this.logger.warn('LinkedIn a demandé une vérification de sécurité — reconnexion automatique abandonnée.');
          return false;
        }
        return !await SESSION_CHECKS.linkedin.isLoginWallVisible(page);
      }

      if (platform === 'indeed') {
        await dismissCookieBanner(page).catch(() => {});
        const emailField = page.locator('input[type="email"]:visible, input[name="__email"]:visible, #login-email-input:visible').first();
        if (await emailField.isVisible({ timeout: 5000 }).catch(() => false)) {
          await humanFill(emailField, email);
          await page.waitForTimeout(500);
          const continueBtn = page.getByRole('button', { name: /^(continuer|continue|next)$/i }).first();
          if (await continueBtn.isVisible().catch(() => false)) {
            await humanClick(page, continueBtn).catch(() => continueBtn.click());
          } else {
            await emailField.press('Enter');
          }
          await page.waitForTimeout(4000);
        }

        // Branch A: Indeed presents "Se connecter avec un code" (dispatches 6-digit email OTP to Gmail)
        const codeLink = page.locator('a:has-text("Se connecter avec un code"), button:has-text("Se connecter avec un code"), a:has-text("code"), button:has-text("code")').first();
        if (await codeLink.isVisible({ timeout: 3000 }).catch(() => false)) {
          const triggerTime = new Date();
          this.logger.log('Indeed presented email code login option — requesting 6-digit code...');
          await humanClick(page, codeLink).catch(() => codeLink.click());
          await page.waitForTimeout(3000);

          const passcodeInput = page.locator('#passcode-input, input[name="passcode"]').first();
          if (await passcodeInput.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
            this.logger.log('Waiting for Indeed OTP code from Gmail...');
            const otpResult = await this.gmailOtp.fetchOtpForPlatform('indeed', userId, { since: triggerTime, maxWaitSeconds: 45 });
            if (otpResult?.code) {
              this.logger.log(`Entering Indeed OTP code [${otpResult.code}]...`);
              await humanFill(passcodeInput, otpResult.code);
              await page.waitForTimeout(800);
              const submitBtn = page.getByRole('button', { name: /^(connexion|sign in|continuer|submit)$/i }).first();
              if (await submitBtn.isVisible().catch(() => false)) {
                await humanClick(page, submitBtn).catch(() => submitBtn.click());
              } else {
                await passcodeInput.press('Enter');
              }
              for (let i = 0; i < 20; i++) {
                await page.waitForTimeout(1000);
                if (!/\/auth|\/secure\.indeed\.com/.test(page.url())) break;
              }
              await page.waitForTimeout(2000);
            }
          }
        } else {
          // Branch B: Standard password field
          const passField = page.locator('input[type="password"]:visible').first();
          if (await passField.isVisible().catch(() => false)) {
            if (pass) {
              await humanFill(passField, pass);
              await page.keyboard.press('Enter');
              await page.waitForTimeout(4000);
            }
          }
          await handleUniversalEmailOtp(page, 'indeed', userId, this.gmailOtp, this.logger);
        }

        return !await SESSION_CHECKS.indeed.isLoginWallVisible(page);
      }

      // Universal fallback for any custom platform
      await handleUniversalEmailOtp(page, platform, userId, this.gmailOtp, this.logger);
      const check = SESSION_CHECKS[platform];
      return check ? !await check.isLoginWallVisible(page) : true;
    } catch (err: any) {
      this.logger.warn(`Automatic background login failed for ${platform}: ${err.message}`);
      return false;
    }
  }
}
