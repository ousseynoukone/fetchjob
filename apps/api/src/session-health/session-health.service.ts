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

  // Before the campaign scheduler's own daily runs (see
  // campaign-scheduler.service.ts) — a dead session is worth knowing about
  // before, not after, today's auto-apply attempts start failing on it.
  // Runs in the morning window (between 6:30 and 8:00) with randomized jitter
  // to avoid fixed periodic bot fingerprints on anti-scraping systems.
  @Cron('30 6 * * *')
  async checkAll() {
    try {
      // Add random jitter between 2 and 45 minutes so it never fires at the exact same minute
      const jitterMs = Math.floor((2 + Math.random() * 43) * 60 * 1000);
      const jitterMinutes = Math.round(jitterMs / 60000);
      this.logger.log(`Session health check triggered. Sleeping ${jitterMinutes}m jitter to mimic human routine...`);
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
      await this.checkOne(credential.userId, credential.platform as SupportedPlatform).catch((error: any) => {
        this.logger.warn(`Session health check failed for ${credential.platform}: ${error.message}`);
      });
      // Pause between platforms to mimic human browsing behavior
      await this.browserSession.randomDelay(15000, 45000);
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
