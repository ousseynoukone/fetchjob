import { Injectable, Logger } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { chromium } from 'playwright';
import { PrismaService } from './prisma.service';
import { CryptoService } from './crypto.service';
import { LocalUserService } from './local-user.service';

export interface OtpFetchResult {
  code: string;
  source: 'imap' | 'web_session';
  email: string;
}

const PLATFORM_SENDER_DOMAINS: Record<string, string[]> = {
  france_travail: ['francetravail.fr', 'pole-emploi.fr'],
  linkedin: ['linkedin.com'],
  indeed: ['indeed.com'],
  hellowork: ['hellowork.com'],
  welcome_to_the_jungle: ['welcometothejungle.com'],
  apec: ['apec.fr'],
};

@Injectable()
export class GmailOtpService {
  private readonly logger = new Logger(GmailOtpService.name);

  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private localUser: LocalUserService,
  ) {}

  /**
   * Fetches an OTP/security verification code for ANY provider (France Travail,
   * LinkedIn, Indeed, HelloWork, APEC, WTTJ, or external ATS).
   * Tries IMAP first (fast, supports Google App Passwords), then falls back to Playwright
   * with stored Gmail session cookies if available.
   */
  async fetchOtpForPlatform(
    platform: string,
    userId?: string,
    options: { maxWaitSeconds?: number; since?: Date } = {},
  ): Promise<OtpFetchResult | null> {
    const resolvedUserId = userId || (await this.localUser.getDefaultUserId());
    const maxWaitSeconds = options.maxWaitSeconds ?? 45;
    const since = options.since ?? new Date(Date.now() - 3 * 60 * 1000); // default last 3 mins
    const deadline = Date.now() + maxWaitSeconds * 1000;

    this.logger.log(`Polling Gmail for [${platform}] security/OTP verification code (max wait: ${maxWaitSeconds}s)...`);

    // 1. Gather all potential Gmail IMAP credentials
    const imapCandidates = await this.getImapCandidates(resolvedUserId);

    // 2. Poll IMAP if any credentials are configured
    if (imapCandidates.length > 0) {
      while (Date.now() < deadline) {
        for (const candidate of imapCandidates) {
          const code = await this.queryImapForOtp(candidate.email, candidate.password, platform, since).catch((err) => {
            this.logger.debug(`IMAP query failed for ${candidate.email}: ${err.message}`);
            return null;
          });

          if (code) {
            this.logger.log(`Retrieved OTP code [${code}] for ${platform} via IMAP from ${candidate.email}`);
            return { code, source: 'imap', email: candidate.email };
          }
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    // 3. Fallback: stored Playwright Gmail web session (if user logged in via integrated remote browser)
    const webSessionCode = await this.queryPlaywrightGmail(resolvedUserId, platform, since, deadline).catch((err) => {
      this.logger.debug(`Playwright Gmail query failed: ${err.message}`);
      return null;
    });

    if (webSessionCode) {
      this.logger.log(`Retrieved OTP code [${webSessionCode.code}] for ${platform} via Gmail Web Session`);
      return webSessionCode;
    }

    this.logger.warn(`Could not retrieve OTP code for ${platform} within ${maxWaitSeconds}s.`);
    return null;
  }

  /**
   * Backwards-compatible alias for France Travail.
   */
  async fetchFranceTravailOtp(
    userId?: string,
    options: { maxWaitSeconds?: number; since?: Date } = {},
  ): Promise<OtpFetchResult | null> {
    return this.fetchOtpForPlatform('france_travail', userId, options);
  }

  /**
   * Collects IMAP login credentials from:
   * 1. `PlatformCredential` with platform='gmail' (user-configured)
   * 2. `Settings` table (smtpUsername / smtpPassword if hosted on Gmail)
   */
  private async getImapCandidates(userId: string): Promise<{ email: string; password: string }[]> {
    const candidates: { email: string; password: string }[] = [];

    // Check platform_credentials for gmail
    try {
      const cred = await this.prisma.platformCredential.findUnique({
        where: { userId_platform: { userId, platform: 'gmail' } },
      });
      if (cred?.emailEncrypted) {
        const email = this.crypto.decrypt(cred.emailEncrypted).trim();
        let pass: string | null = null;
        if (cred.sessionStateEncrypted) {
          const decrypted = this.crypto.decrypt(cred.sessionStateEncrypted);
          try {
            const parsed = JSON.parse(decrypted);
            pass = parsed.password || parsed.storageState || null;
          } catch {
            if (decrypted && !decrypted.startsWith('{')) pass = decrypted;
          }
        }
        if (email && pass) {
          candidates.push({ email, password: pass });
        }
      }
    } catch (err: any) {
      this.logger.warn(`Error reading Gmail platform credential: ${err.message}`);
    }

    // Check settings table for SMTP credentials
    try {
      const settings = await this.prisma.settings.findFirst();
      if (settings?.smtpHost?.toLowerCase().includes('gmail') && settings.smtpUsername && settings.smtpPassword) {
        if (!candidates.some((c) => c.email.toLowerCase() === settings.smtpUsername!.toLowerCase())) {
          candidates.push({ email: settings.smtpUsername, password: settings.smtpPassword });
        }
      }
    } catch (err: any) {
      this.logger.warn(`Error reading SMTP settings: ${err.message}`);
    }

    return candidates;
  }

  /**
   * Connects to Gmail IMAP, scans inbox for provider security emails, and parses the OTP code.
   */
  private async queryImapForOtp(user: string, pass: string, platform: string, since: Date): Promise<string | null> {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: user.trim(),
        pass: pass.trim().replace(/\s+/g, ''), // Strip spaces from Google App Passwords
      },
      logger: false,
    });

    client.on('error', (err) => this.logger.debug(`IMAP client error: ${err?.message}`));

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const domains = PLATFORM_SENDER_DOMAINS[platform];
        let messages: number[] = [];

        if (domains && domains.length > 0) {
          const orFilter = domains.map((d) => ({ from: d }));
          const res = await client.search(orFilter.length === 1 ? orFilter[0] : ({ or: orFilter } as any));
          if (Array.isArray(res)) messages = res;
        }

        // If no messages found by specific domain, search recent messages (since timestamp)
        if (messages.length === 0) {
          const res = await client.search({ since });
          if (Array.isArray(res)) messages = res;
        }

        if (!messages || messages.length === 0) return null;

        // Inspect newest 3 messages (newest first)
        const recentMessages = messages.slice(-3).reverse();
        for (const seq of recentMessages) {
          const msg = await client.fetchOne(seq, { envelope: true, source: true });
          if (!msg) continue;

          const msgDate = msg.envelope?.date ? new Date(msg.envelope.date) : null;
          // Accept messages within 120s skew of the request time
          if (msgDate && msgDate.getTime() < since.getTime() - 120 * 1000) {
            continue;
          }

          const bodyText = msg.source?.toString('utf8') || '';
          const code = this.extractOtpCode(bodyText);
          if (code) return code;
        }

        return null;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /**
   * Fallback using a stored Playwright Gmail session (if user signed into Gmail via the integrated browser).
   */
  private async queryPlaywrightGmail(
    userId: string,
    platform: string,
    since: Date,
    deadline: number,
  ): Promise<OtpFetchResult | null> {
    const cred = await this.prisma.platformCredential.findUnique({
      where: { userId_platform: { userId, platform: 'gmail' } },
    });
    if (!cred?.sessionStateEncrypted) return null;

    let storageState: any = null;
    try {
      const decrypted = this.crypto.decrypt(cred.sessionStateEncrypted);
      const parsed = JSON.parse(decrypted);
      storageState = parsed.storageState || (parsed.cookies ? parsed : null);
    } catch {
      return null;
    }

    if (!storageState) return null;

    const browser = await chromium.launch({
      headless: true,
      channel: 'chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const context = await browser.newContext({
        storageState,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        locale: 'fr-FR',
      });
      const page = await context.newPage();

      const domains = PLATFORM_SENDER_DOMAINS[platform];
      const searchQuery = domains && domains.length > 0
        ? domains.map((d) => `from:${d}`).join('+OR+')
        : 'code+OR+verification+OR+sécurité+OR+security';

      await page.goto(`https://mail.google.com/mail/u/0/#search/${searchQuery}`, {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });

      while (Date.now() < deadline) {
        // Find newest email row
        const row = page.locator('tr[role="row"], .zA').first();
        if (await row.isVisible({ timeout: 4000 }).catch(() => false)) {
          await row.click().catch(() => {});
          await page.waitForTimeout(1500);

          const content = await page.locator('div[role="main"], .ii.gt').innerText().catch(() => '');
          const code = this.extractOtpCode(content);
          if (code) {
            const email = cred.emailEncrypted ? this.crypto.decrypt(cred.emailEncrypted) : 'gmail';
            return { code, source: 'web_session', email };
          }
        }
        await page.waitForTimeout(3000);
      }
    } finally {
      await browser.close().catch(() => {});
    }

    return null;
  }

  /**
   * Extracts the 8-digit, 6-digit, or 4-digit verification code from email body/HTML.
   */
  extractOtpCode(text: string): string | null {
    if (!text) return null;

    // Clean HTML tags and quoted-printable encoding
    const clean = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/=\r?\n/g, '')
      .replace(/=C3=A0/gi, 'à')
      .replace(/=C3=A9/gi, 'é')
      .replace(/=C3=A8/gi, 'è')
      .replace(/=20/g, ' ')
      .replace(/&nbsp;/gi, ' ');

    // 1. Explicit regex targeting code phrases (French & English):
    // e.g. "Votre code à usage unique est le : 31842999", "code de validation est : 12345678", "votre code de sécurité : 123456"
    const explicitPatterns = [
      /(?:code\s*(?:(?:à|a)\s*usage\s*unique)?\s*(?:de\s*)?(?:validation|confirmation|connexion|sécurité|securite|vérification|verification|accès|acces)?\s*(?:est(?:\s*le)?|is)?\s*[:\s]*)([0-9]{6,8})\b/i,
      /(?:security\s*code|verification\s*code|one-time\s*(?:passcode|code|pin)|confirmation\s*code|your\s*code\s*is|votre\s*code\s*est)\s*[:\s]?\s*([0-9]{4,8})\b/i,
      /(?:saisissez\s*le\s*code\s*suivant|enter\s*the\s*following\s*code)\s*[:\s]?\s*([0-9]{4,8})\b/i,
    ];

    for (const pat of explicitPatterns) {
      const match = clean.match(pat);
      if (match && match[1]) {
        return match[1];
      }
    }

    // 2. Direct 8-digit sequence (France Travail format, ignore year timestamps e.g. 2026...)
    const eightDigitMatches = clean.match(/\b[0-9]{8}\b/g);
    if (eightDigitMatches && eightDigitMatches.length > 0) {
      for (const m of eightDigitMatches) {
        if (!m.startsWith('202') && !m.startsWith('19') && !m.startsWith('10512')) {
          return m;
        }
      }
    }

    // 3. Direct 6-digit sequence (LinkedIn, Indeed, HelloWork, APEC)
    const sixDigitMatches = clean.match(/\b[0-9]{6}\b/g);
    if (sixDigitMatches && sixDigitMatches.length > 0) {
      return sixDigitMatches[0];
    }

    // 4. 4-digit PIN code fallback
    const pinMatch = clean.match(/\b(?:pin|code)\s*[:\s]?\s*([0-9]{4})\b/i);
    if (pinMatch) return pinMatch[1];

    return null;
  }
}
