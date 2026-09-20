import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Page } from 'playwright';
import { PrismaService } from '../common/prisma.service';
import { PlatformCredentialsService } from '../platform-credentials/platform-credentials.service';
import { SupportedPlatform } from '../platform-credentials/dto/upsert-credential.dto';
import { BrowserSessionService } from '../auto-apply/browser-session.service';
import { SESSION_CHECKS, blockHeavyResources, dismissCookieBanner, handleUniversalEmailOtp } from '../auto-apply/appliers/ats-common';
import { REMOTE_LOGIN_URLS } from '../platform-credentials/remote-login.service';
import { GmailOtpService } from '../common/gmail-otp.service';

@Injectable()
export class SessionHealthService implements OnModuleInit {
  private readonly logger = new Logger(SessionHealthService.name);

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

  async run(force = false): Promise<{ platform: string; status: 'refreshed' | 'expired' | 'error' | 'skipped' }[]> {
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
        cred.email &&
        cred.password &&
        cred.email !== '(session importée)' &&
        cred.email !== '(connecté via navigateur intégré)'
      ) {
        this.logger.log(`No active session cookies for ${platform} — attempting background login with stored credentials...`);
        const context = await this.browserSession.createContext(null, platform);
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
          await context.close().catch(() => {});
        }
      }
      return 'expired';
    }

    // Pass platform so BrowserSessionService applies site-specific fingerprints and cookie caches
    const context = await this.browserSession.createContext(cred.sessionState, platform);
    try {
      await blockHeavyResources(context);
      const page = await context.newPage();
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

      const onLoginWall = await check.isLoginWallVisible(page);
      if (onLoginWall) {
        // If credentials (email + password) are available, attempt automatic background re-login
        // so the user does NOT have to open the manual remote browser repeatedly!
        if (cred.email && cred.password && cred.email !== '(session importée)' && cred.email !== '(connecté via navigateur intégré)') {
          this.logger.log(`Session expired for ${platform} — attempting automatic background re-login...`);
          const relogged = await this.attemptBackgroundLogin(page, platform, cred.email, cred.password, userId);
          if (relogged) {
            const freshState = await context.storageState();
            await this.credentials.saveSessionState(userId, platform, JSON.stringify(freshState));
            await this.browserSession.persistContextCookies(context, platform).catch(() => {});
            this.logger.log(`Session automatically restored and refreshed for ${platform}`);
            return 'refreshed';
          }
        }

        await this.credentials.recordSessionExpired(userId, platform);
        return 'expired';
      }

      const freshState = await context.storageState();
      await this.credentials.saveSessionState(userId, platform, JSON.stringify(freshState));
      await this.browserSession.persistContextCookies(context, platform).catch(() => {});
      this.logger.log(`Session successfully refreshed and kept alive for ${platform}`);
      return 'refreshed';
    } finally {
      await context.close().catch(() => {});
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

      if (platform === 'linkedin') {
        const emailField = page.locator('input#username, input[name="session_key"]').first();
        const passField = page.locator('input#password, input[name="session_password"]').first();
        if ((await emailField.isVisible().catch(() => false)) && (await passField.isVisible().catch(() => false))) {
          await emailField.fill(email);
          await passField.fill(pass);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(5000);

          await handleUniversalEmailOtp(page, 'linkedin', userId, this.gmailOtp, this.logger);

          const url = page.url();
          return !url.includes('/login') && !url.includes('/checkpoint');
        }
      }

      if (platform === 'indeed') {
        const emailField = page.locator('#login-email-input, input[name="__email"]').first();
        if (await emailField.isVisible().catch(() => false)) {
          await emailField.fill(email);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(2500);
          const passField = page.locator('input[type="password"]').first();
          if (await passField.isVisible().catch(() => false)) {
            await passField.fill(pass);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(4000);
          }

          await handleUniversalEmailOtp(page, 'indeed', userId, this.gmailOtp, this.logger);

          return !await SESSION_CHECKS.indeed.isLoginWallVisible(page);
        }
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
