/**
 * BrowserSessionService
 * =====================
 * Manages the persistent Playwright browser used by ALL auto-apply flows.
 *
 * STEALTH ENABLED: every context created here inherits the full stealth
 * fingerprint stack from stealth-browser.ts — so France Travail, LinkedIn,
 * Indeed, HelloWork, Greenhouse, Lever, Workday and every other applier
 * automatically gets bot-detection evasion without any per-applier changes.
 *
 * Why a shared browser singleton?
 *   - Launching Chromium takes ~1-2s — reusing the same process is far
 *     cheaper for a sequence of apply attempts in a single campaign run.
 *   - Session state (cookies, localStorage) is per-context, so each apply
 *     attempt gets its own isolated context while sharing the browser process.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { chromium as stealthChromium } from 'playwright-extra';
import type { Browser, BrowserContext } from 'playwright';
import {
  buildFingerprintScript,
  randomProfile,
  loadCookies,
  saveCookies,
  FINGERPRINT_PROFILES,
} from '../scraping/stealth-browser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
stealthChromium.use(StealthPlugin());

@Injectable()
export class BrowserSessionService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserSessionService.name);
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await stealthChromium.launch({
        headless: process.env.AUTO_APPLY_HEADLESS !== 'false',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-background-networking',
          '--mute-audio',
          '--no-first-run',
          '--disable-infobars',
          '--js-flags=--max-old-space-size=128',
          '--lang=fr-FR',
        ],
      });
      this.logger.log('Stealth browser launched for auto-apply');
    }
    return this.browser;
  }

  /**
   * Creates a new stealth BrowserContext for one apply attempt.
   *
   * @param sessionStateJson  Persisted storage state (cookies + localStorage)
   *                          from a previous session, as produced by
   *                          `context.storageState()`.  Pass null for a fresh
   *                          anonymous session.
   * @param siteName          Used to restore/persist site-specific cookies
   *                          (e.g. 'france_travail', 'linkedin', 'indeed').
   *                          Complements the storageState for sites whose
   *                          session is tracked via cookies rather than
   *                          localStorage.
   */
  async createContext(sessionStateJson: string | null, siteName?: string): Promise<BrowserContext> {
    const browser = await this.getBrowser();

        // For authenticated sessions or platforms that monitor device consistency (like LinkedIn),
    // always use a standard Windows 10 Chrome desktop profile rather than a random Safari profile.
    const fp = (sessionStateJson || siteName === 'linkedin') ? FINGERPRINT_PROFILES[0] : randomProfile();

    let storageState: any;
    if (sessionStateJson) {
      try {
        storageState = JSON.parse(sessionStateJson);
        if (storageState && Array.isArray(storageState.cookies)) {
          storageState.cookies = storageState.cookies.map((c: any) => {
            if (c.domain && c.domain.includes('linkedin.com')) {
              return { ...c, domain: '.linkedin.com' };
            }
            return c;
          });
        }
      } catch {
        this.logger.warn('Stored session state was not valid JSON — starting a fresh session.');
      }
    }

    const context = await browser.newContext({
      userAgent: fp.userAgent,
      viewport: fp.viewport,
      locale: fp.locale,
      timezoneId: fp.timezoneId,
      deviceScaleFactor: fp.deviceScaleFactor,
      colorScheme: 'light',
      storageState,
      extraHTTPHeaders: {
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        DNT: '1',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    // Inject fingerprint overrides before any page script runs
    await context.addInitScript(buildFingerprintScript(fp));

    // Restore persisted site cookies (supplements storageState)
    if (siteName) {
      const saved = loadCookies(siteName);
      if (saved.length > 0) {
        await context.addCookies(saved as Parameters<typeof context.addCookies>[0]).catch(() => {});
      }
    }

    // Route handler to abort image and media requests to save massive memory and bandwidth
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media') {
        return route.abort();
      }
      return route.continue();
    });

    return context;
  }

  /**
   * Persist the context's current cookies to disk so the next run
   * can restore them and skip re-authentication.
   * Call this after a successful apply attempt.
   */
  async persistContextCookies(context: BrowserContext, siteName: string): Promise<void> {
    try {
      saveCookies(siteName, await context.cookies());
    } catch { /* non-critical */ }
  }

  /**
   * Human-scale delay between actions — not primarily an anti-detection measure,
   * but prevents the bot-obvious burst of instant sequential requests.
   */
  async randomDelay(minMs: number, maxMs: number): Promise<void> {
    const ms = minMs + Math.random() * (maxMs - minMs);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async onModuleDestroy() {
    await this.browser?.close();
    this.browser = null;
  }
}
