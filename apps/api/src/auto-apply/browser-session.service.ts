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

// A cookie export pasted from a browser extension (Cookie-Editor,
// EditThisCookie, ...) is a bare array of cookie objects using Chrome's own
// cookie-API field names/values (expirationDate, hostOnly, sameSite:
// "no_restriction"/"unspecified"), not Playwright's storageState shape
// ({cookies: [...]}) or field names (expires, sameSite: "None"|"Lax"|
// "Strict"). Normalizing this is what lets someone paste a session exported
// from their own regular, already-logged-in browser as a fallback —
// confirmed necessary live: HelloWork's own FriendlyCaptcha widget failed
// outright even inside establish-session.js's real, human-driven browser
// window, with no automation-detection explanation (identical failure with
// and without stealth patching), leaving "export from a normal browser" as
// the only remaining way to get a working session at all.
// Safe to run on an already-correct Playwright storageState array too: every
// branch below passes already-well-formed fields through unchanged.
function normalizeCookieExport(raw: any[]): any[] {
  return raw
    .filter((c) => c && typeof c.name === 'string' && typeof c.domain === 'string')
    .map((c) => {
      const domain = c.hostOnly === false && !c.domain.startsWith('.') ? `.${c.domain}` : c.domain;

      const sameSiteRaw = String(c.sameSite ?? '').toLowerCase();
      const sameSite: 'Strict' | 'Lax' | 'None' =
        sameSiteRaw === 'strict' ? 'Strict' : sameSiteRaw === 'no_restriction' || sameSiteRaw === 'none' ? 'None' : 'Lax';

      const expires =
        typeof c.expires === 'number' ? c.expires : typeof c.expirationDate === 'number' ? c.expirationDate : -1;

      return {
        name: c.name,
        value: c.value ?? '',
        domain,
        path: c.path || '/',
        expires,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite,
      };
    });
}

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
          // 128MB was tight enough to plausibly crash the renderer on a
          // heavy client-rendered SPA (confirmed live: a LinkedIn job page
          // that returned a completely blank screenshot, and a separate
          // Easy Apply modal load that took the whole process down --
          // right where the modal's question-set API response gets
          // rendered, the single biggest DOM/JS spike in this whole flow).
          // Raised modestly rather than aggressively: the service's total
          // container budget is only ~512MB shared with the Node/Nest
          // process itself and Postgres client buffers, and only one
          // Chromium renderer is ever active at a time (applyToOne
          // processes one application at a time, sequentially) -- if
          // restarts persist, the next step is watching Render's memory
          // graph during a run, not raising this further blind.
          '--renderer-process-limit=1',
          '--disable-accelerated-2d-canvas',
          '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider',
          '--js-flags=--max-old-space-size=160',
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
        let parsed = JSON.parse(sessionStateJson);
        while (typeof parsed === 'string') {
          try {
            parsed = JSON.parse(parsed);
          } catch {
            break;
          }
        }
        // A pasted cookie-extension export is a bare array rather than
        // Playwright's own {cookies: [...]} storageState shape — wrap it so
        // the rest of this logic (and browser.newContext's own storageState
        // option) can treat both the same way.
        if (Array.isArray(parsed)) {
          parsed = { cookies: parsed };
        }
        if (parsed && typeof parsed === 'object') {
          storageState = parsed;
          if (Array.isArray(storageState.cookies)) {
            storageState.cookies = normalizeCookieExport(storageState.cookies);
            if (siteName === 'linkedin') {
              storageState.cookies = storageState.cookies.filter((c: any) =>
                c.domain && c.domain.includes('linkedin.com') && !c.domain.includes('fr.linkedin.com')
              );
            }
            storageState.cookies = storageState.cookies.map((c: any) => {
              if (c.domain && c.domain.includes('linkedin.com')) {
                return { ...c, domain: '.linkedin.com' };
              }
              return c;
            });
          }
        }
      } catch {
        this.logger.warn('Stored session state was not valid JSON — starting a fresh session.');
      }
    }
    if (typeof storageState === 'string') {
      storageState = undefined;
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

    // Route handler to abort heavy media, fonts, and tracking scripts to prevent OOM
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      const url = route.request().url();
      if (type === 'image' || type === 'media' || type === 'font') {
        return route.abort();
      }
      if (/demdex\.net|scorecardresearch|google-analytics|googletagmanager|clarity\.ms|datadoghq/i.test(url)) {
        return route.abort();
      }
      if (/linkedin\.com\/feed\/?(\?.*)?$/i.test(url)) {
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
