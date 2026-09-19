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

  // Confirmed live: cookies carry their own real expiry timestamp (the
  // `expires` field in storageState, Unix seconds) -- rather than guess a
  // one-size-fits-all recheck interval, read that directly per credential
  // and only spend a live browser visit on the ones actually close to
  // expiring. A visit this close still leaves margin to catch it and email
  // before the candidate portal actually locks the session out.
  private static readonly REFRESH_MARGIN_MS = 90 * 60 * 1000;

  // Ticks every 30 minutes -- cheap on its own (each tick just reads stored
  // cookie expiry timestamps; the costly live browser visit only runs for
  // credentials the expiry check below flags as due). Before this, the
  // whole batch ran on one fixed interval regardless of how much life any
  // individual session's cookies actually had left, so a France Travail
  // session with a short-lived cookie and a LinkedIn session with a
  // month-long one got the exact same treatment -- either too late for the
  // first or wastefully often for the second.
  @Cron('*/30 * * * *')
  async checkAll() {
    try {
      // Short jitter (30s-4min) so it doesn't fire at a robotic fixed
      // second, not the old 2-45min spread -- that would eat most of this
      // tick's own 30-minute window.
      const jitterMs = Math.floor((30 + Math.random() * 210) * 1000);
      await new Promise((resolve) => setTimeout(resolve, jitterMs));

      await this.run();
    } catch (error: any) {
      this.logger.warn(`Session health check failed: ${error.message}`);
    }
  }

  private async run() {
    const credentials = await this.prisma.platformCredential.findMany({
      where: { sessionStateEncrypted: { not: null } },
    });

    for (const credential of credentials) {
      const due = await this.isRefreshDue(credential.userId, credential.platform as SupportedPlatform).catch(
        (error: any) => {
          this.logger.warn(`Session expiry read failed for ${credential.platform}: ${error.message}`);
          return true; // unknown state -- err toward checking it rather than silently skipping
        },
      );
      if (!due) continue;

      await this.checkOne(credential.userId, credential.platform as SupportedPlatform).catch((error: any) => {
        this.logger.warn(`Session health check failed for ${credential.platform}: ${error.message}`);
      });
      // Pause between platforms to mimic human browsing behavior
      await this.browserSession.randomDelay(15000, 45000);
    }
  }

  // Cookies with no fixed expiry (session-only, `expires: -1`) can't be
  // predicted ahead of time -- those fall back to the old fixed cadence
  // (roughly every 3 hours) rather than being checked on every 30-minute
  // tick, which would be needless extra live-browser traffic to sites that
  // already have no expiry signal to act on anyway.
  private async isRefreshDue(userId: string, platform: SupportedPlatform): Promise<boolean> {
    const { sessionState } = await this.credentials.getDecrypted(userId, platform);
    if (!sessionState) return false; // already flagged expired earlier — nothing new to check

    const earliestExpiryMs = this.earliestCookieExpiryMs(sessionState);
    if (earliestExpiryMs === null) return new Date().getHours() % 3 === 0;

    return earliestExpiryMs - Date.now() <= SessionHealthService.REFRESH_MARGIN_MS;
  }

  private earliestCookieExpiryMs(sessionStateJson: string): number | null {
    try {
      let parsed = JSON.parse(sessionStateJson);
      while (typeof parsed === 'string') parsed = JSON.parse(parsed);
      const cookies = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];

      let earliest: number | null = null;
      for (const cookie of cookies) {
        const expires = typeof cookie?.expires === 'number' ? cookie.expires : typeof cookie?.expirationDate === 'number' ? cookie.expirationDate : -1;
        if (expires <= 0) continue; // session-only cookie, no fixed expiry to compare
        const expiresMs = expires * 1000;
        if (earliest === null || expiresMs < earliest) earliest = expiresMs;
      }
      return earliest;
    } catch {
      return null;
    }
  }

  private async checkOne(userId: string, platform: SupportedPlatform) {
    const check = SESSION_CHECKS[platform];
    if (!check) return;

    const { sessionState } = await this.credentials.getDecrypted(userId, platform);
    if (!sessionState) return; // already flagged expired earlier — nothing new to check

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
      } else {
        const freshState = await context.storageState();
        await this.credentials.saveSessionState(userId, platform, JSON.stringify(freshState));
        this.logger.log(`Session successfully refreshed for ${platform}`);
      }
    } finally {
      await context.close().catch(() => {});
    }
  }
}
