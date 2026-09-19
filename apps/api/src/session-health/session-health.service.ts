import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { PlatformCredentialsService } from '../platform-credentials/platform-credentials.service';
import { SupportedPlatform } from '../platform-credentials/dto/upsert-credential.dto';
import { BrowserSessionService } from '../auto-apply/browser-session.service';
import { SESSION_CHECKS, blockHeavyResources } from '../auto-apply/appliers/ats-common';

// A stored session doesn't announce its own death — the appliers only find
// out once a real candidature attempt hits the login wall, which means a
// dead LinkedIn/Indeed/HelloWork/France Travail session can otherwise sit
// unnoticed until the next campaign run, quietly turning every candidature
// on that platform into a `needs_review`. This runs the exact same
// login-wall check each applier does (see SESSION_CHECKS), but proactively
// on a schedule and with no candidature attached — so the existing
// "session expired" email (see PlatformCredentialsService.recordSessionExpired)
// fires before a campaign run ever needs that session, not after.
@Injectable()
export class SessionHealthService {
  private readonly logger = new Logger(SessionHealthService.name);

  constructor(
    private prisma: PrismaService,
    private credentials: PlatformCredentialsService,
    private browserSession: BrowserSessionService,
  ) {}

  // Refreshed ahead of its OWN expiry, per session -- not on a fixed clock.
  // Two earlier versions of this got it wrong in opposite directions and
  // both are worth not repeating:
  //   - Refreshing only once a session was ~90min from expiring: too tight.
  //     A clock skew, a cookie whose declared `expires` doesn't match what
  //     the platform actually enforces, or a container that was simply down
  //     over that window, and the session is gone before anything touched it.
  //   - Refreshing every session on every 30min tick regardless of remaining
  //     life: worse. A dedicated, unauthenticated-looking visit to the same
  //     login-gated page 48x/day forever is exactly the fixed-interval
  //     machine pattern the rest of this codebase works to avoid (see
  //     stealth-browser.ts, humanClick, the jitter everywhere), and it buys
  //     nothing: a sliding-window session only needs touching more often
  //     than its own window, and a hard server-side TTL can't be extended by
  //     visiting at all -- only a real re-login fixes that one.
  // So: a wide margin off each session's own real expiry, which for a
  // typical multi-day cookie means this fires rarely (once every day or
  // two), and for a genuinely short-lived one fires often enough to matter.
  private static readonly REFRESH_MARGIN_MS = 8 * 60 * 60 * 1000;

  // Cookies with no computable expiry (session-only, `expires: -1`) give
  // nothing to schedule against -- checked roughly daily rather than on
  // every tick, since without an expiry signal a more frequent visit adds
  // detectable regularity without adding information.
  private static readonly UNKNOWN_EXPIRY_RECHECK_MS = 20 * 60 * 60 * 1000;

  // The tick is only a scheduling opportunity, NOT "refresh everything now"
  // -- almost every tick does nothing but read stored expiry timestamps
  // (free, no network, no browser) and go back to sleep.
  @Cron('*/30 * * * *')
  async checkAll() {
    try {
      const jitterMs = Math.floor((30 + Math.random() * 210) * 1000);
      await new Promise((resolve) => setTimeout(resolve, jitterMs));

      await this.run();
    } catch (error: any) {
      this.logger.warn(`Session health check failed: ${error.message}`);
    }
  }

  // `force` is the manual "check now" path (see SessionHealthController):
  // a person explicitly asking for a live answer right now overrides the
  // scheduling above, since that's a one-off human action, not a recurring
  // machine pattern.
  async run(force = false): Promise<{ platform: string; status: 'refreshed' | 'expired' | 'error' | 'skipped' }[]> {
    const credentials = await this.prisma.platformCredential.findMany({
      where: { sessionStateEncrypted: { not: null } },
    });

    const results: { platform: string; status: 'refreshed' | 'expired' | 'error' | 'skipped' }[] = [];
    for (const credential of credentials) {
      const platform = credential.platform as SupportedPlatform;

      if (!force) {
        const due = await this.isRefreshDue(credential.userId, platform, credential.lastLoginAt).catch(() => true);
        if (!due) {
          results.push({ platform, status: 'skipped' });
          continue;
        }
      }

      const status = await this.checkOne(credential.userId, platform).catch((error: any) => {
        this.logger.warn(`Session health check failed for ${platform}: ${error.message}`);
        return 'error' as const;
      });
      results.push({ platform, status });
      // Pause between platforms to mimic human browsing behavior
      await this.browserSession.randomDelay(15000, 45000);
    }
    return results;
  }

  private async isRefreshDue(
    userId: string,
    platform: SupportedPlatform,
    lastRefreshedAt: Date | null,
  ): Promise<boolean> {
    const { sessionState } = await this.credentials.getDecrypted(userId, platform);
    if (!sessionState) return false; // already flagged expired earlier — nothing new to check

    const earliestExpiryMs = this.earliestCookieExpiryMs(sessionState);
    if (earliestExpiryMs !== null) {
      return earliestExpiryMs - Date.now() <= SessionHealthService.REFRESH_MARGIN_MS;
    }

    // No expiry to schedule against — fall back to "has it been long enough
    // since the last successful refresh", which at least paces off real
    // activity rather than a fixed wall-clock cadence every session shares.
    if (!lastRefreshedAt) return true;
    return Date.now() - lastRefreshedAt.getTime() >= SessionHealthService.UNKNOWN_EXPIRY_RECHECK_MS;
  }

  private earliestCookieExpiryMs(sessionStateJson: string): number | null {
    try {
      let parsed = JSON.parse(sessionStateJson);
      while (typeof parsed === 'string') parsed = JSON.parse(parsed);
      const cookies = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];

      let earliest: number | null = null;
      for (const cookie of cookies) {
        const expires =
          typeof cookie?.expires === 'number'
            ? cookie.expires
            : typeof cookie?.expirationDate === 'number'
              ? cookie.expirationDate
              : -1;
        if (expires <= 0) continue; // session-only cookie, no fixed expiry to compare
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

    const { sessionState } = await this.credentials.getDecrypted(userId, platform);
    if (!sessionState) return 'expired'; // already flagged expired earlier — nothing new to check

    const context = await this.browserSession.createContext(sessionState);
    try {
      await blockHeavyResources(context);
      const page = await context.newPage();
      await page.goto(check.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000 + Math.random() * 2000);

      // Simulate natural human glance and smooth scrolling on feed
      await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        if (win && win.scrollBy) {
          win.scrollBy({ top: 300 + Math.random() * 250, behavior: 'smooth' });
        }
      }).catch(() => {});
      await page.waitForTimeout(2000 + Math.random() * 1500);

      if (await check.isLoginWallVisible(page)) {
        await this.credentials.recordSessionExpired(userId, platform);
        return 'expired';
      }

      const freshState = await context.storageState();
      await this.credentials.saveSessionState(userId, platform, JSON.stringify(freshState));
      this.logger.log(`Session successfully refreshed for ${platform}`);
      return 'refreshed';
    } finally {
      await context.close().catch(() => {});
    }
  }
}
