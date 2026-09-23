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
import { chromium as stealthChromium } from 'patchright';
import type { Browser, BrowserContext } from 'playwright';
// See cdp-endpoint.ts for why a real host Chrome over CDP is the strongest
// anti-bot posture available, and the two Chrome quirks it works around.
import { CDP_URL, resolveCdpEndpoint } from '../common/cdp-endpoint';
import {
  buildFingerprintScript,
  randomProfile,
  loadCookies,
  saveCookies,
  FINGERPRINT_PROFILES,
  withCurrentChromeVersion,
} from '../scraping/stealth-browser';

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
  // Whether `this.browser` is genuinely the host Chrome over CDP, as
  // opposed to a Chromium launched inside this container. Tracked
  // separately from the static CDP_URL env var: when the host Chrome is
  // configured but unreachable, getBrowser() falls back to an internal
  // launch WHILE CDP_URL stays set, and createContext() needs to know which
  // one actually happened to decide whether to apply fingerprint spoofing
  // (only correct for an internal browser — the host Chrome's real values
  // must never be overwritten with fake ones, see createContext below).
  private usingHostChrome = false;

  private async getBrowser(): Promise<Browser> {
    // Confirmed live: a genuinely dead/unresponsive browser process doesn't
    // always throw or disconnect cleanly — but when it does disconnect,
    // reusing the same cached reference would silently hand every future
    // apply attempt a broken browser forever, with no way to recover short
    // of restarting the whole container. Checked on every call instead of
    // only at launch.
    if (this.browser && !this.browser.isConnected()) {
      this.logger.warn('Cached browser is disconnected — relaunching.');
      this.browser = null;
      this.usingHostChrome = false;
    }
    if (!this.browser && CDP_URL) {
      // Still patchright: its patches are protocol-level (e.g. never
      // issuing the detectable Runtime.enable), which a site can spot no
      // matter how the browser was started. What's dropped over CDP is the
      // PAGE-level disguise (UA/locale/WebGL overrides, see createContext):
      // this browser is genuine, and overwriting real values with fake ones
      // would manufacture exactly the contradictions those exist to hide.
      const endpoint = await resolveCdpEndpoint(CDP_URL);
      // Confirmed live (headless vs headed, side by side): once the
      // internal launch below uses the right SwiftShader flags, it produces
      // the EXACT SAME fingerprint whether headed or headless -- there's no
      // fidelity this used to be protecting by refusing to fall back. A host
      // Chrome that isn't running any more (laptop off, browser closed) used
      // to hard-fail every single apply/scrape attempt until someone noticed
      // and restarted it by hand; this now falls back to the internal
      // browser instead, loudly logged so it's never a silent downgrade.
      const connected = await stealthChromium.connectOverCDP(endpoint, { timeout: 15000 }).catch((err: any) => {
        this.logger.warn(
          `Host Chrome not reachable at ${endpoint} (${err.message}) — falling back to the browser inside this container.`,
        );
        return null;
      });
      if (connected) {
        this.browser = connected as unknown as Browser;
        this.usingHostChrome = true;
        this.logger.log(`Connected to host Chrome over CDP at ${endpoint} (${this.browser.version()})`);
        return this.browser;
      }
    }
    if (!this.browser) {
      this.usingHostChrome = false;
      const headless = process.env.AUTO_APPLY_HEADLESS !== 'false';
      // Confirmed live, headless AND headed (Xvfb), side by side: without
      // these flags `canvas.getContext('webgl')` returns null outright --
      // not a software-renderer string, no WebGL at all, which no real
      // browser ever does and is a far stronger bot tell than any renderer
      // string. This used to instead pass `--disable-software-rasterizer`
      // on the assumption that a software renderer string was the bigger
      // risk; that flag is what was breaking WebGL, and the assumption was
      // never actually tested. With these three flags, headless and headed
      // report the IDENTICAL fingerprint (SwiftShader via ANGLE/Vulkan) --
      // there turned out to be no fidelity difference between the two to
      // trade off. AUTO_APPLY_HEADLESS still exists as a manual override
      // (headed needs the Xvfb virtual display docker-entrypoint.sh starts
      // when there's no host Chrome), but the default, headless, is not
      // giving up anything by being simpler to deploy.
      const gpuArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
      this.browser = (await stealthChromium.launch({
        headless,
        // Without this, Playwright launches its lightweight
        // "chrome-headless-shell" binary for headless mode instead of full
        // Chromium — confirmed live: a real hang landed inside a LinkedIn
        // Easy Apply modal's `page.evaluate()` call with the process alive
        // but completely idle (0% CPU, no timeout, no crash — just never
        // resolving), a known class of compatibility gap between the
        // stripped-down shell and complex React SPAs. `channel: 'chromium'`
        // forces the full browser binary (already installed by the
        // Dockerfile's `playwright install chromium`, which bundles both).
        channel: 'chromium',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-dev-shm-usage',
          ...gpuArgs,
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
          //
          // Confirmed live AGAIN locally (a Docker container with 15GB
          // available, nowhere near Render's 512MB): the exact same
          // Easy Apply modal crashed the renderer outright ("Page
          // crashed") — this budget is tuned specifically for Render's
          // constraint, not a universal safe value, so it's configurable
          // instead of hardcoded. Bump CHROMIUM_RENDERER_HEAP_MB in a local
          // .env if renderer crashes show up in local testing; production
          // keeps today's 160 unless Render's own env vars are changed.
          '--renderer-process-limit=1',
          '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider',
          `--js-flags=--max-old-space-size=${process.env.CHROMIUM_RENDERER_HEAP_MB || '160'}`,
          '--lang=fr-FR',
        ],
      })) as unknown as Browser;
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
    const ACCOUNT_PLATFORMS = new Set([
      'linkedin',
      'france_travail',
      'hellowork',
      'indeed',
      'apec',
      'welcome_to_the_jungle',
    ]);
    const isAccountPlatform = siteName && ACCOUNT_PLATFORMS.has(siteName);
    const rawFp = (sessionStateJson || isAccountPlatform) ? FINGERPRINT_PROFILES[0] : randomProfile();
    // Confirmed live: these profiles' own Chrome version segment (127/126)
    // was 26+ major versions behind the actually-installed Chromium build
    // (153) -- a mismatch bot management systems like Cloudflare check for
    // directly via `navigator.userAgentData` (Client Hints), separate from
    // the legacy UA string. See withCurrentChromeVersion.
    const fp = withCurrentChromeVersion(rawFp, browser.version());

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
          }
        }
      } catch {
        this.logger.warn('Stored session state was not valid JSON — starting a fresh session.');
      }
    }
    if (typeof storageState === 'string') {
      storageState = undefined;
    }

    // Over CDP the browser is a real desktop Chrome: its own UA, Client
    // Hints, locale, timezone, headers and WebGL are all genuine and all
    // consistent with each other. Forcing the emulated profile on top (a UA
    // string pinned to another Chrome version, spoofed WebGL strings, ...)
    // would replace real values with fake ones -- the checkable
    // contradictions this file's own comments warn about. Only the cookies
    // and a fixed viewport (which remote-login's screencast coordinates
    // assume) are applied; everything else is left to the browser.
    const context = (await browser.newContext(
      this.usingHostChrome
        ? {
            viewport: { width: 1280, height: 800 },
            // Emulated separately from the viewport: in headless mode the
            // screen would otherwise report exactly the viewport size, and
            // "screen == browser window" is a shape no real desktop has.
            screen: { width: 1920, height: 1080 },
            storageState,
          }
        : {
            userAgent: fp.userAgent,
            viewport: { width: 1280, height: 800 }, // Aligné avec remote-login pour avoir exactement la même empreinte
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
          },
    )) as unknown as BrowserContext;

    // Inject fingerprint overrides before any page script runs -- never over
    // CDP (see above).
    if (!this.usingHostChrome && siteName !== 'hellowork' && siteName !== 'apec') {
      await context.addInitScript(buildFingerprintScript(fp));
    }

    // Restore persisted site cookies (supplements storageState) — but never
    // let a stale on-disk cookie from a PAST run clobber a same-name/domain
    // cookie the caller just supplied via sessionStateJson (the DB-stored
    // session, which is always the freshest source of truth: it's what
    // gets overwritten every time a real session is (re-)established).
    // Confirmed live: this file can accumulate cookies across many apply
    // attempts in one night (33 here, vs. 17 in a freshly re-saved DB
    // session) — `addCookies` applied on top of `newContext({storageState})`
    // blindly overwrites any matching cookie, so a single leftover, now-
    // invalid JSESSIONID_CANDIDAT from hours earlier silently downgraded a
    // just-verified, working France Travail session back to a logged-out
    // one on every single apply attempt, with no error anywhere in the
    // chain — the isolated reproduction (which never calls loadCookies)
    // kept succeeding while the real app kept failing identically.
    //
    // LinkedIn specifically skips this merge entirely rather than trying to
    // filter it more precisely: confirmed live AGAIN, a second time, that
    // an exact name+domain+path match wasn't narrow enough -- a stale
    // on-disk cookie (a different domain variant of the same logical
    // cookie, e.g. `li_at` under a slightly different scope) slipped past
    // the "already exists" check as "supplemental" and still broke a
    // freshly-established, genuinely valid session (the login page's own
    // wall check started reporting logged-out again), which then cascaded
    // into performDirectLogin attempting a password login with a WRONG,
    // unrelated password borrowed from a different credential row's own
    // fallback lookup. LinkedIn's session is always captured as one
    // complete storageState snapshot (establish-session.js, and now
    // RemoteLoginService) -- there's no legitimate case where it still
    // needs supplementing from this file, only ways for it to get hurt by
    // one.
    if (siteName && !ACCOUNT_PLATFORMS.has(siteName)) {
      const saved = loadCookies(siteName);
      if (saved.length > 0) {
        const existingKeys = new Set(
          (storageState?.cookies || []).map((c: any) => `${c.name}|${c.domain}|${c.path}`),
        );
        const supplemental = saved.filter((c: any) => !existingKeys.has(`${c.name}|${c.domain}|${c.path}`));
        if (supplemental.length > 0) {
          await context.addCookies(supplemental as Parameters<typeof context.addCookies>[0]).catch(() => {});
        }
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
