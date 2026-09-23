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
 *   1. patchright (patched Playwright)    → removes CDP-protocol-level artefacts
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
// Confirmed live: playwright-extra + puppeteer-extra-plugin-stealth (JS-level
// overrides only) was NOT enough to get past Indeed's own Cloudflare bot
// management, even combined with a correct fingerprint (channel: 'chromium'
// below, real cookies). patchright is a patched Playwright fork that closes
// CDP-protocol-level leaks (e.g. the Runtime.enable leak) stealth plugins
// can't reach at all, since those operate one layer up, in page JS -- real,
// verified fix: the exact same request that returned a Cloudflare challenge
// through playwright-extra returned a clean 200 with real results through
// patchright alone, no stealth plugin needed on top of it.
import { chromium } from 'patchright';
import { CDP_URL, resolveCdpEndpoint } from '../common/cdp-endpoint';

// Docker-volume-backed (see docker-compose.yml), same reasoning and same
// pattern as remote-login.service.ts's PROFILE_BASE_DIR: a real, per-site
// Chrome profile that accumulates cookies/localStorage/engagement signals
// across runs instead of starting from zero-history every single scrape,
// which several sites' bot detection (Indeed's Cloudflare WAF especially)
// treats as its own signal.
const SCRAPING_PROFILE_BASE_DIR =
  process.env.SCRAPING_PROFILE_DIR || path.join(os.homedir(), '.findurjob', 'scraping-profiles');

// See createStealthContext's fpForLaunch/realVersion handling below.
let cachedChromeVersion: string | null = null;

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
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
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

// Confirmed live: these profiles' own "Chrome/127.0.0.0" / "Chrome/126.0.0.0"
// strings are hardcoded and drift out of date the moment a newer Chromium
// build gets installed (`browser.version()` reported 153.0.8010.12 against
// these -- a 26-major-version gap) -- exactly the kind of UA-vs-real-engine
// mismatch Cloudflare/PerimeterX-style bot management checks for: modern
// Chrome also exposes its REAL version via `navigator.userAgentData`
// (Client Hints), which puppeteer-extra-plugin-stealth's own user-agent
// override derives from whatever UA string it's handed rather than probing
// the engine itself -- so a stale profile UA propagates into a stale (but
// self-consistent-looking) Client Hints payload too, not just the legacy
// header. Rewriting the Chrome version segment to match the ACTUAL running
// browser at context-creation time removes this whole class of mismatch
// instead of periodically hand-editing these strings as Chromium updates.
// Left alone for a profile with no "Chrome/" segment (the Safari one) --
// Safari's own version isn't tied to this project's Chromium build at all.
export function withCurrentChromeVersion(fp: FingerprintProfile, realVersion: string): FingerprintProfile {
  if (!fp.userAgent.includes('Chrome/')) return fp;
  const userAgent = fp.userAgent.replace(/Chrome\/[\d.]+/, `Chrome/${realVersion}`);
  return { ...fp, userAgent };
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
      vendor:              { get: () => 'Google Inc.' },
    });
  } catch(e) {}

  // 2. WebGL vendor/renderer spoofing (ONLY applied if running in Docker/Linux)
  // On native Windows/Mac, spoofing WebGL is counter-productive because the real GPU
  // is trusted, and JS-based spoofing is easily detected by Cloudflare.
  if (${process.platform === 'linux'}) {
    const patchWebGL = (klass) => {
      const orig = klass.prototype.getParameter;
      klass.prototype.getParameter = function(param) {
        if (param === 37445) return ${v};
        if (param === 37446) return ${r};
        return orig.apply(this, arguments);
      };
      // Mask the toString to avoid basic detection
      klass.prototype.getParameter.toString = function() {
        return "function getParameter() { [native code] }";
      };
    };
    try { patchWebGL(WebGLRenderingContext); } catch(e) {}
    try { patchWebGL(WebGL2RenderingContext); } catch(e) {}
  
    // 3. navigator.plugins — headless Linux usually has 0 plugins
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
  }

  // 4. Remove CDP / Playwright window markers
  ['cdc_adoQpoasnfa76pfcZLmcfl_Array','cdc_adoQpoasnfa76pfcZLmcfl_Promise',
   'cdc_adoQpoasnfa76pfcZLmcfl_Symbol','__playwright','__pw_manual','_playwrightRunner',
  ].forEach(k => { try { delete window[k]; } catch(e) {} });

  // 5. Spoof window.chrome and Notification.permission
  try {
    if (!window.chrome) {
      window.chrome = { app: { isInstalled: false }, runtime: {} };
    }
    if (window.Notification && Notification.permission === 'denied') {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    }
  } catch(e) {}

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
  // Same real, host-side Chrome the auto-apply, remote-login and session
  // checks already drive (see cdp-endpoint.ts). Confirmed live: the
  // in-container Chromium scrapers were the last thing still running with
  // a spoofed fingerprint from a container -- LinkedIn blocked that guest
  // scraper (0 cards) and killed the person's logged-in session from the
  // same IP within the same minute, and Indeed's Cloudflare wall hit it
  // on every query. A real Chrome on the host presents one consistent
  // identity: no fingerprint script, no forced UA/timezone/headers -- the
  // browser's own values are the ones that agree with everything else.
  // Cookie jars are kept per site AND per mode ("<site>-host"), since a
  // Cloudflare/DataDome clearance minted for the container's fingerprint
  // is worse than no cookie at all on a different browser.
  if (CDP_URL) {
    if (options.proxy) {
      console.warn(`[stealth-browser] proxy ${options.proxy.server} ignored: scraping goes through the host Chrome (BROWSER_CDP_URL), which has no per-context proxy.`);
    }
    const endpoint = await resolveCdpEndpoint(CDP_URL);
    // Confirmed live: this used to throw here, which took down the WHOLE
    // campaign run the moment the host Chrome wasn't running (not just this
    // one source) -- the very first scrape call fails, executeRun's own
    // try/catch has nothing to fall back to, and the run ends with zero
    // offers scanned. Falls through to the in-container launch below
    // instead, logged clearly so it's visible this happened rather than
    // silently changing behaviour.
    const browser = await chromium.connectOverCDP(endpoint).catch((error: any) => {
      console.warn(
        `[stealth-browser] Host Chrome not reachable at ${endpoint} for scraping (${error.message}) — falling back to the browser inside this container.`,
      );
      return null;
    });
    if (browser) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        screen: { width: 1920, height: 1080 },
        colorScheme: 'light',
      });
      if (options.siteName) {
        const saved = loadCookies(`${options.siteName}-host`);
        if (saved.length > 0) {
          await context.addCookies(saved as Parameters<typeof context.addCookies>[0]).catch(() => {});
        }
      }
      const fp = withCurrentChromeVersion(FINGERPRINT_PROFILES[0], browser.version());
      return { browser, context, fp };
    }
  }

  const rawFp = options.profileIndex !== undefined ? FINGERPRINT_PROFILES[options.profileIndex] : randomProfile();
  // launchPersistentContext takes `userAgent` at LAUNCH time, unlike a plain
  // launch()+newContext() pair where newContext() (and the browser.version()
  // read before it) can run after the browser already exists. The corrected
  // version is only knowable AFTER a browser has actually started, so it's
  // cached process-wide from the first real launch and reused by every
  // later one -- only the very first launch in this process's life risks an
  // uncorrected version in its UA string.
  const fpForLaunch = cachedChromeVersion ? withCurrentChromeVersion(rawFp, cachedChromeVersion) : rawFp;
  const isHeadless = process.env.AUTO_APPLY_HEADLESS !== 'false';

  const launchArgs = [
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
    // See browser-session.service.ts's identical flags: without these,
    // canvas.getContext('webgl') returns null in this container, which is
    // a stronger bot tell than any software-renderer string (no real
    // browser has zero WebGL support).
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ];

  // Confirmed live (and documented for the identical remote-login-profiles
  // volume): "residential proxies are essential", "browser fingerprinting
  // and IP reputation" and, repeatedly, that a brand-new zero-history
  // profile is itself a bot signal Cloudflare/Indeed's WAF checks for. Every
  // call here used to be `chromium.launch()` + `newContext()`, which is an
  // ISOLATED, throwaway context even when pointed at a real user-data-dir --
  // Playwright's incognito-style contexts don't write back to the profile's
  // real on-disk storage the way a genuine tab does, so this never actually
  // accumulated anything across runs regardless of channel/args. Indeed
  // scraped 0 offers through this every time; the host Chrome (a real,
  // accumulating profile via CDP) scraped 80. launchPersistentContext is
  // the only API that genuinely persists cookies/localStorage/IndexedDB/
  // engagement signals to disk, one real profile per site, backed by the
  // same kind of Docker volume as remote-login-profiles (see docker-compose.yml).
  const profileDir = options.siteName
    ? path.join(SCRAPING_PROFILE_BASE_DIR, options.siteName)
    : path.join(SCRAPING_PROFILE_BASE_DIR, `anon-${Date.now()}`);
  await fs.promises.mkdir(profileDir, { recursive: true }).catch(() => {});

  const launchOptions = {
    headless: isHeadless,
    // Confirmed live on Indeed: without this, Playwright launches its own
    // bundled chrome-headless-shell -- a stripped-down binary missing
    // `window.chrome` entirely and reporting zero navigator.plugins, both
    // concrete, checkable automation signals a real Chrome browser (even
    // headless) never gives off. `channel: 'chromium'` uses the full,
    // unmodified Chromium binary instead, same fix already applied to
    // remote-login.service.ts and establish-session.js for the same
    // reason.
    channel: 'chromium',
    args: launchArgs,
    userAgent: fpForLaunch.userAgent,
    viewport: fpForLaunch.viewport,
    locale: fpForLaunch.locale,
    timezoneId: fpForLaunch.timezoneId,
    deviceScaleFactor: fpForLaunch.deviceScaleFactor,
    colorScheme: 'light' as const,
    extraHTTPHeaders: {
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      DNT: '1',
      'Upgrade-Insecure-Requests': '1',
    },
    ...(options.proxy ? { proxy: options.proxy } : {}),
  };

  // Same recovery as remote-login.service.ts: a process that died without
  // releasing this profile leaves Chrome's own SingletonLock/-Socket/
  // -Cookie files behind, and every future launch on that same profile dir
  // fails with "Failed to create a ProcessSingleton...File exists" until
  // they're cleared.
  let context: import('patchright').BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (launchErr: any) {
    await Promise.all(
      ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'].map((name) =>
        fs.promises.unlink(path.join(profileDir, name)).catch(() => {}),
      ),
    );
    context = await chromium.launchPersistentContext(profileDir, launchOptions).catch(async () => {
      const fallbackDir = path.join(SCRAPING_PROFILE_BASE_DIR, `${options.siteName || 'anon'}-${Date.now()}`);
      return chromium.launchPersistentContext(fallbackDir, launchOptions);
    });
  }

  // See withCurrentChromeVersion — keeps the declared UA's Chrome version in
  // sync with whatever Chromium build is actually running it. A persistent
  // context's own .browser() is non-null in patchright (unlike stock
  // Playwright, which returns null for it), so this still works the same.
  const realVersion = context.browser()?.version();
  if (realVersion) cachedChromeVersion = realVersion;
  const fp = realVersion ? withCurrentChromeVersion(rawFp, realVersion) : fpForLaunch;

  // Restore persisted cookies (warms the session for sites that use them) --
  // still worth doing on top of the profile's own accumulated cookies: the
  // app-level jar is what a DB-driven re-login writes back, the profile is
  // what accumulates from ordinary browsing here.
  if (options.siteName) {
    const saved = loadCookies(options.siteName);
    if (saved.length > 0) {
      await context.addCookies(saved as Parameters<typeof context.addCookies>[0]).catch(() => {});
    }
  }

  // Inject fingerprint overrides before any page script runs
  await context.addInitScript(buildFingerprintScript(fp));

  // Callers only ever call `browser.close()` for cleanup -- closing a
  // persistent context's real browser() handle (when patchright provides
  // one) or the context itself both tear down the same underlying process.
  const browser = context.browser() ?? ({ close: () => context.close(), version: () => 'unknown' } as any);

  return { browser, context, fp };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Block images, media, fonts and known tracker URLs.
 * Keeps JS and CSS (needed for page hydration and WAF challenges).
 * Call after creating the context, before opening pages.
 */
export async function blockUnnecessaryResources(context: import('patchright').BrowserContext): Promise<void> {
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
export async function simulateHumanMouse(page: import('patchright').Page): Promise<void> {
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
  context: import('patchright').BrowserContext,
  siteName: string,
): Promise<void> {
  try {
    // Same per-mode jar split as createStealthContext.
    saveCookies(CDP_URL ? `${siteName}-host` : siteName, await context.cookies());
  } catch { /* non-critical */ }
}

/**
 * Returns true if the page shows a bot-challenge / login-wall.
 * Call after every navigation to know whether to abort.
 */
export async function isBotChallengePage(page: import('patchright').Page): Promise<boolean> {
  try {
    const url = page.url();
    if (/challenge|captcha|authwall|security-check|verify/i.test(url)) return true;
    const text = await page.locator('body').innerText({ timeout: 2000 });
    // Confirmed live on Indeed: a Cloudflare "Request Blocked" page (own
    // title "Blocked - Indeed.com", body text "You have been blocked... Ray
    // ID... Your current IP...") matched none of the wording below, so this
    // returned false and the scraper silently cheerio-parsed a blocked page
    // for job cards, finding zero and logging nothing to explain why. This
    // is a real, outright IP-level block (not a stale selector) -- fixing
    // detection doesn't un-block the IP, but at least surfaces WHY nothing
    // came back instead of looking like an empty result set.
    return /authwall|sign in to continue|unusual activity|captcha|verify you are human|browser check failed|you have been blocked|request blocked|ray id|access denied|pardon our interruption|attention required.*cloudflare/i.test(
      text,
    );
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
