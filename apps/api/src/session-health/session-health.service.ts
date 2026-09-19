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

  // Corrected after explicit feedback: an earlier version of this only
  // spent a live visit on a credential once its cookies were computed to be
  // close to actually expiring (or, for session-only cookies with no
  // computable expiry, on a slow ~3h fallback cadence) -- reasoned as
  // minimizing unnecessary traffic, but that's backwards for what this is
  // actually for. Visiting a still-valid session is itself what renews a
  // sliding-window cookie (most login systems use one) -- waiting until
  // it's ALMOST dead to first touch it defeats that, and for a platform
  // with a genuinely short/non-sliding TTL, the 3h fallback could still
  // miss the window entirely. Every credential gets a real visit on every
  // tick now, unconditionally -- the point is to keep every session
  // continuously warm, not to compute the minimum traffic that gets away
  // with not doing that.
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

  // Exposed for a manual "check now" trigger (see
  // PlatformCredentialsController) as well as the cron above -- the same
  // full refresh pass either way, just fired on demand instead of waiting
  // for the next tick.
  async run(): Promise<{ platform: string; status: 'refreshed' | 'expired' | 'error' }[]> {
    const credentials = await this.prisma.platformCredential.findMany({
      where: { sessionStateEncrypted: { not: null } },
    });

    const results: { platform: string; status: 'refreshed' | 'expired' | 'error' }[] = [];
    for (const credential of credentials) {
      const status = await this.checkOne(credential.userId, credential.platform as SupportedPlatform).catch(
        (error: any) => {
          this.logger.warn(`Session health check failed for ${credential.platform}: ${error.message}`);
          return 'error' as const;
        },
      );
      results.push({ platform: credential.platform, status });
      // Pause between platforms to mimic human browsing behavior
      await this.browserSession.randomDelay(15000, 45000);
    }
    return results;
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
