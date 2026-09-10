/**
 * stealth-browser.ts
 * ==================
 * Universal stealth Playwright browser factory.
 * Used by ALL scrapers that need bot-detection evasion (LinkedIn, Indeed, HelloWork, ...).
 *
 * Works WITHOUT a proxy — fingerprint spoofing + stealth plugin alone is
 * effective against most bot-detection systems. Add SCRAPER_PROXIES to
 * .env for extra IP rotation if you ever get blocked.
 *
 * Anti-detection layers:
 *   1. playwright-extra + stealth plugin  → removes all CDP/Playwright artefacts
 *   2. Rotating realistic fingerprints    → UA, viewport, platform, GPU vendor
 *   3. WebGL vendor/renderer spoofing     → defeats GPU fingerprinting
 *   4. Canvas pixel noise                 → defeats canvas fingerprinting
 *   5. navigator.plugins faker            → headless normally has 0 plugins
 *   6. Human-like mouse movement          → random waypoints before navigation
 *   7. Random timing jitter               → looks like human reading pace
 *   8. Tracker / heavy-resource blocking  → reduces fingerprint surface
 *   9. Cookie persistence                 → keeps sessions warm across runs
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chromium } from 'playwright-extra';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

// ─── Fingerprint profiles ─────────────────────────────────────────────────────

export interface FingerprintProfile {
  userAgent: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  platform: string;
  webglVendor: string;
  webglRenderer: string;
  colorDepth: number;
  deviceScaleFactor: number;
  hardwareConcurrency: number;
  deviceMemory: number;
}

/**
 * Pool of 4 realistic browser fingerprints.
 * One is selected randomly per scraping session — each run looks like a
 * different device to any anti-bot system that fingerprints across requests.
 */
export const FINGERPRINT_PROFILES: FingerprintProfile[] = [
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    platform: 'Win32',
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    colorDepth: 24,
    deviceScaleFactor: 1,
    hardwareConcurrency: 8,
    deviceMemory: 8,
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    viewport: { width: 1440, height: 900 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    platform: 'MacIntel',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple M2',
    colorDepth: 30,
    deviceScaleFactor: 2,
    hardwareConcurrency: 10,
    deviceMemory: 16,
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    viewport: { width: 1366, height: 768 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    platform: 'Win32',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    colorDepth: 24,
    deviceScaleFactor: 1,
    hardwareConcurrency: 4,
    deviceMemory: 4,
  },
  {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    platform: 'Linux x86_64',
    webglVendor: 'Mesa/X.org',
    webglRenderer: 'Mesa Intel Xe Graphics (TGL GT2)',
    colorDepth: 24,
    deviceScaleFactor: 1,
    hardwareConcurrency: 8,
    deviceMemory: 8,
  },
];

export function randomProfile(): FingerprintProfile {
  return FINGERPRINT_PROFILES[Math.floor(Math.random() * FINGERPRINT_PROFILES.length)];
}

// ─── Timing helpers ───────────────────────────────────────────────────────────

/** Random delay between [min, max] ms — makes timing look human. */
export function jitter(min: number, max: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

// ─── Proxy support (optional) ─────────────────────────────────────────────────

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Optional round-robin proxy rotator.
 * Set SCRAPER_PROXIES in .env with newline-separated proxy URLs to use.
 * Leave empty (default) for direct connections — stealth works without proxies.
 *
 * Format: "http://user:pass@host:port" or "socks5://host:port"
 */
export class ProxyRotator {
  private index = 0;

  constructor(private readonly proxies: ProxyConfig[]) {}

  next(): ProxyConfig | undefined {
    if (this.proxies.length === 0) return undefined;
    return this.proxies[this.index++ % this.proxies.length];
  }

  get size(): number {
    return this.proxies.length;
  }

  static fromEnv(envVar: string): ProxyRotator {
    const raw = process.env[envVar] ?? '';
    const proxies: ProxyConfig[] = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const url = new URL(line);
          return {
            server: `${url.protocol}//${url.hostname}:${url.port}`,
            username: url.username || undefined,
            password: url.password || undefined,
          };
        } catch {
          return { server: line };
        }
      });
    return new ProxyRotator(proxies);
  }
}

// ─── Cookie persistence ───────────────────────────────────────────────────────

const COOKIE_BASE_DIR = path.join(os.homedir(), '.findurjob', 'cookies');

function cookiePath(siteName: string): string {
  return path.join(COOKIE_BASE_DIR, `${siteName}.json`);
}

export function loadCookies(siteName: string): object[] {
  try {
    const p = cookiePath(siteName);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* corrupt — start fresh */ }
  return [];
}

export function saveCookies(siteName: string, cookies: object[]): void {
  try {
    fs.mkdirSync(COOKIE_BASE_DIR, { recursive: true });
    fs.writeFileSync(cookiePath(siteName), JSON.stringify(cookies, null, 2));
  } catch { /* non-critical */ }
}

// ─── Fingerprint injection script (runs inside page context) ─────────────────

/**
 * Builds the JS snippet injected into every page via addInitScript().
 * Runs BEFORE any page script — overrides are always in effect.
 */
export function buildFingerprintScript(fp: FingerprintProfile): string {
  const v = JSON.stringify(fp.webglVendor);
  const r = JSON.stringify(fp.webglRenderer);
  const p = JSON.stringify(fp.platform);

  return `(function(){
  // 1. navigator overrides
  try {
    Object.defineProperties(navigator, {
      platform:            { get: () => ${p} },
      hardwareConcurrency: { get: () => ${fp.hardwareConcurrency} },
      deviceMemory:        { get: () => ${fp.deviceMemory} },
      languages:           { get: () => ['fr-FR','fr','en-US','en'] },
      webdriver:           { get: () => false },
      vendor:              { get: () => 'Google Inc.' },
    });
  } catch(e) {}

  // 2. WebGL vendor/renderer spoofing
  const patchWebGL = (klass) => {
    const orig = klass.prototype.getParameter;
    klass.prototype.getParameter = function(param) {
      if (param === 37445) return ${v};
      if (param === 37446) return ${r};
      return orig.apply(this, arguments);
    };
  };
  try { patchWebGL(WebGLRenderingContext); } catch(e) {}
  try { patchWebGL(WebGL2RenderingContext); } catch(e) {}

  // 3. Canvas pixel noise — tiny per-session shift defeats canvas fingerprinting
  const _tdu = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, ...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const d = ctx.getImageData(0, 0, this.width || 1, this.height || 1);
      const i = Math.floor(Math.random() * d.data.length / 4) * 4;
      d.data[i] = Math.max(0, Math.min(255, d.data[i] + (Math.random() > .5 ? 1 : -1)));
      ctx.putImageData(d, 0, 0);
    }
    return _tdu.apply(this, [type, ...args]);
  };

  // 4. navigator.plugins — headless shows 0; fake 3 standard Chrome ones
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const a = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        Object.setPrototypeOf(a, window.PluginArray.prototype);
        return a;
      },
    });
  } catch(e) {}

  // 5. Remove CDP / Playwright window markers
  ['cdc_adoQpoasnfa76pfcZLmcfl_Array','cdc_adoQpoasnfa76pfcZLmcfl_Promise',
   'cdc_adoQpoasnfa76pfcZLmcfl_Symbol','__playwright','__pw_manual','_playwrightRunner',
  ].forEach(k => { try { delete window[k]; } catch(e) {} });

  // 6. screen colorDepth
  try {
    Object.defineProperties(screen, {
      colorDepth: { get: () => ${fp.colorDepth} },
      pixelDepth:  { get: () => ${fp.colorDepth} },
    });
  } catch(e) {}
})();`;
}

// ─── Context factory ──────────────────────────────────────────────────────────

export interface StealthContextOptions {
  /** Site name for cookie persistence (e.g. 'linkedin', 'indeed', 'hellowork'). */
  siteName?: string;
  /** Optional proxy. Leave undefined for direct connection (stealth works fine without). */
  proxy?: ProxyConfig;
  /** Force a specific fingerprint profile index 0-3. Default: random. */
  profileIndex?: number;
}

/**
 * Creates a stealth Playwright BrowserContext pre-loaded with:
 *   - Stealth plugin (no CDP/Playwright artefacts)
 *   - Random realistic fingerprint
 *   - Persisted cookies (optional, per siteName)
 *   - Optional proxy
 *
 * Always call `context.close()` and `browser.close()` in a finally block.
 */
export async function createStealthContext(options: StealthContextOptions = {}) {
  const fp = options.profileIndex !== undefined ? FINGERPRINT_PROFILES[options.profileIndex] : randomProfile();
  const isHeadless = process.env.AUTO_APPLY_HEADLESS !== 'false';

  const browser = await chromium.launch({
    headless: isHeadless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // The single most important flag — tells Chromium NOT to add the
      // "navigator.webdriver" property and removes automation-specific flags
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-infobars',
      '--lang=fr-FR',
    ],
    ...(options.proxy ? { proxy: options.proxy } : {}),
  });

  const context = await browser.newContext({
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    deviceScaleFactor: fp.deviceScaleFactor,
    colorScheme: 'light',
    extraHTTPHeaders: {
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      DNT: '1',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  // Restore persisted cookies (warms the session for sites that use them)
  if (options.siteName) {
    const saved = loadCookies(options.siteName);
    if (saved.length > 0) {
      await context.addCookies(saved as Parameters<typeof context.addCookies>[0]).catch(() => {});
    }
  }

  // Inject fingerprint overrides before any page script runs
  await context.addInitScript(buildFingerprintScript(fp));

  return { browser, context, fp };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Block images, media, fonts and known tracker URLs.
 * Keeps JS and CSS (needed for page hydration and WAF challenges).
 * Call after creating the context, before opening pages.
 */
export async function blockUnnecessaryResources(context: import('playwright').BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url = route.request().url();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    if (/doubleclick|google-analytics|facebook\.net|bat\.bing|ads\.linkedin|hotjar|clarity\.ms/.test(url))
      return route.abort();
    return route.continue();
  });
}

/**
 * Move the mouse through 3-6 random waypoints.
 * Call before navigating to the target URL — looks like a human scanning the page.
 */
export async function simulateHumanMouse(page: import('playwright').Page): Promise<void> {
  try {
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const moves = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < moves; i++) {
      await page.mouse.move(
        Math.floor(Math.random() * vp.width),
        Math.floor(Math.random() * vp.height),
        { steps: 8 + Math.floor(Math.random() * 20) },
      );
      await jitter(60, 280);
    }
  } catch { /* non-critical */ }
}

/**
 * Save the context's cookies to disk for reuse next run.
 */
export async function persistCookies(
  context: import('playwright').BrowserContext,
  siteName: string,
): Promise<void> {
  try {
    saveCookies(siteName, await context.cookies());
  } catch { /* non-critical */ }
}

/**
 * Returns true if the page shows a bot-challenge / login-wall.
 * Call after every navigation to know whether to abort.
 */
export async function isBotChallengePage(page: import('playwright').Page): Promise<boolean> {
  try {
    const url = page.url();
    if (/challenge|captcha|authwall|security-check|verify/i.test(url)) return true;
    const text = await page.locator('body').innerText({ timeout: 2000 });
    return /authwall|sign in to continue|unusual activity|captcha|verify you are human|browser check failed/i.test(text);
  } catch {
    return false;
  }
}

/**
 * Bounded concurrency map — runs fn over items with at most `limit` in parallel.
 * Prevents hammering a site with too many simultaneous requests.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
