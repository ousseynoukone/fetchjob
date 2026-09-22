import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { chromium } from 'patchright';
import type { BrowserContext, Page, CDPSession } from 'patchright';
import { Subject, Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import { CryptoService } from '../common/crypto.service';
import { LocalUserService } from '../common/local-user.service';
import { PrismaService } from '../common/prisma.service';
import { SESSION_CHECKS, dismissCookieBanner } from '../auto-apply/appliers/ats-common';
import { buildFingerprintScript, FINGERPRINT_PROFILES, saveCookies } from '../scraping/stealth-browser';
import { SupportedPlatform } from './dto/upsert-credential.dto';
import { CDP_URL, resolveCdpEndpoint } from '../common/cdp-endpoint';

// Docker-volume-backed (see docker-compose.yml) so a real, accumulating
// Chrome profile per platform survives container restarts/rebuilds instead
// of starting from a completely blank, zero-history browser on every single
// login attempt -- confirmed live that a real person's own repeat login was
// recognized as a trusted device/location by LinkedIn itself once the other
// fingerprint gaps were closed, and a persistent profile is the next step
// toward "looks like the same returning browser" rather than "looks new
// every time". Not backed by a persistent volume on Render's free tier
// (no such thing there), so this only actually helps local testing today.
import * as os from 'os';
const PROFILE_BASE_DIR = process.env.REMOTE_LOGIN_PROFILE_DIR || path.join(os.homedir(), '.findurjob', 'remote-login-profiles');

// Google's own multi-step login (identifier -> password -> 2FA, all on
// accounts.google.com) makes both of this service's other automatic
// behaviors actively counterproductive for it specifically:
//  - prefillSavedCredential auto-typing an email/password into a Google
//    form is exactly the "saisie automatisée" Google detects and penalizes
//    accounts for -- skipped entirely, never attempted, even if a password
//    happened to be stored.
//  - pollLoginState's every-2s DOM check, repeated across however many
//    steps a real 2FA/captcha challenge takes, is itself a repeated
//    automated read of a Google auth page -- skipped in favor of a single,
//    explicit check the person themselves triggers by clicking "J'ai
//    terminé" once they're actually done (see confirmManualLogin).
const MANUAL_CONFIRM_PLATFORMS = new Set<SupportedPlatform>(['gmail']);

// Platforms whose login flow can park a LOGGED-IN person on a page the
// page-level check still reads as "login wall". Confirmed live on Indeed:
// every auth screen lives on secure.indeed.com, and so do its post-login
// interstitials (passkey / phone-number prompts), so after a successful
// one-time-code login the person sat on secure.indeed.com, genuinely
// connected, while both the 2s poll and "Valider la session" kept saying
// "la page de connexion semble toujours active". No rule about the page
// itself settles this; probeLoggedIn (a real load of the authenticated
// home in the same context) does.
const PROBE_ON_AMBIGUOUS_PLATFORMS = new Set<SupportedPlatform>(['indeed']);
const AMBIGUOUS_PROBE_INTERVAL_MS = 20_000;

export interface RemoteLoginFrame {
  dataUrl: string | null;
  status: 'active' | 'done' | 'error';
  message?: string;
}

export type RemoteLoginInputEvent =
  | { kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'insertText'; text: string }
  | { kind: 'key'; key: 'Enter' | 'Backspace' | 'Tab' | 'Escape' }
  | { kind: 'reload' }
  | { kind: 'prefill' };

interface ActiveSession {
  platform: SupportedPlatform;
  context: BrowserContext;
  page: Page;
  cdpSession: CDPSession;
  frames: Subject<RemoteLoginFrame>;
  pollTimer: NodeJS.Timeout;
  autoCloseTimer?: NodeJS.Timeout;
  consecutiveLoggedIn: number;
  closed: boolean;
  // setInterval keeps firing whether or not the previous tick finished --
  // a tick that outlives the 2s interval (a slow DOM read on a page still
  // loading) would otherwise stack up concurrent Playwright operations
  // against the same page, starving the CDP screencast and freezing the
  // live view exactly when someone is trying to log in.
  polling?: boolean;
  // Set once a saved credential has actually been written into the form, so
  // the retry-on-every-tick below stops -- otherwise it would refill a
  // field the person deliberately cleared to retype.
  prefilledEmail?: boolean;
  prefilledPassword?: boolean;
  // Best-effort capture of whatever the user types into the login form
  // during this session -- not read back this session, only saved once
  // login succeeds so the NEXT login to this same platform can be
  // pre-filled instead of retyped from scratch (see prefillSavedCredential).
  capturedEmail?: string;
  capturedPassword?: string;
  // One automatic recovery per session when the browser lands on a Chrome
  // error page (see recoverFromErrorPage) -- a second failure means the
  // problem isn't stale cookies, and looping on it would just hide that.
  recoveredFromErrorPage?: boolean;
  // Last time probeLoggedIn ran from the poll (rate limit, see there).
  lastProbeAt?: number;
}

// A Chrome network-error page (ERR_TOO_MANY_REDIRECTS, ERR_CONNECTION_*,
// ...) is neither a login wall nor an authenticated page -- it's a third
// state every platform's isLoginWallVisible was written without. Confirmed
// live on LinkedIn: no /login in the URL, no #username, no sign-in header,
// no logged-out body text, so the check returned "not on the login wall",
// two ticks later that counted as a genuine login, and a dead redirect loop
// got saved to the DB as a working session ("Session enregistrée !").
async function isBrowserErrorPage(page: Page): Promise<boolean> {
  if (page.url().startsWith('chrome-error://')) return true;
  const body = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  return /\bERR_[A-Z_]+\b|cette page ne fonctionne pas|this site can.t be reached|impossible d.acc[ée]der [àa] ce site/i.test(body);
}

// Dedicated direct login URLs for each platform so the user lands straight
// on the authentication form, rather than having to navigate from marketing homepages.
export const REMOTE_LOGIN_URLS: Record<SupportedPlatform, string> = {
  linkedin: 'https://www.linkedin.com/login',
  indeed: 'https://secure.indeed.com/account/login',
  hellowork: 'https://www.hellowork.com/fr-fr/candidat/connexion-inscription.html#connexion',
  france_travail: 'https://candidat.francetravail.fr/espacepersonnel/',
  welcome_to_the_jungle: 'https://www.welcometothejungle.com/fr/signin',
  apec: 'https://www.apec.fr/candidat/mon-espace.html',
  gmail: 'https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/',
  // No account needed to apply (see freework.applier.ts) -- listed only so
  // the Comptes page can still store a fallback email/password for the
  // rare offer that does show a login wall. Confirmed live: the previous
  // URL here (.../tech-it/candidate/login) was a genuine 404 on
  // free-work.com's own side -- the person landed on that error page and
  // the login-wall check (only "is a password field visible") read the
  // absent field as "already logged in", saving that broken page's cookies
  // as if they were a real session. /fr/resume redirects cleanly to
  // /fr/login?redirect=/fr/resume when logged out (verified 200) and lands
  // straight back on the résumé page once actually logged in.
  free_work: 'https://www.free-work.com/fr/resume',
};

// Generic enough to match every platform's own login form without needing a
// per-platform selector map: an email/identifier-like field, and any
// password field. Used both to auto-fill a previously-saved credential
// (prefillSavedCredential) and to recognize which field the user is
// currently typing into (captureTypedCredential).
const LOGIN_EMAIL_SELECTOR =
  'input[type="email"], input[autocomplete*="username" i], input[name*="email" i], input[id*="email" i], input[name*="identifiant" i], input[id*="identifiant" i], input[name="__email"], input[name="session_key"], input#username, input[data-testid*="email" i]';
const LOGIN_PASSWORD_SELECTOR =
  'input[type="password"], input[name*="password" i], input[id*="password" i], input[name="session_password"], input#password, input[data-testid*="password" i]';
// Written when nothing was captured for the login identifier (see
// captureTypedCredential) -- checked against by name, not by shape (an `@`
// test), since not every platform's login identifier is an email address.
// France Travail in particular logs in with a plain "identifiant" that has
// no reason to contain one.
const NO_CAPTURED_EMAIL_PLACEHOLDER = '(connecté via navigateur intégré)';

// Confirmed live via a real recorded WTTJ login (a user-provided Chrome
// DevTools Recorder export): its own "Me garder connecté" toggle is a
// custom-styled div, not a native <input type="checkbox"> -- no selector
// generic enough to find that across platforms, but its visible TEXT is a
// reliable, common pattern across login forms generally. Checked
// proactively during prefill (same reasoning as prefillSavedCredential:
// remove the easy-to-forget, non-sensitive parts of login so the person
// only has to handle the CAPTCHA/2FA that actually needs them) so the
// resulting session is the long-lived variant by default rather than
// depending on the person remembering to click it themselves.
const REMEMBER_ME_TEXT = /me garder connect[ée]|rester connect[ée]|se souvenir de moi|keep me signed in|remember me|stay signed in/i;

// Mirrors the CDP `key`/`code`/`keyCode` triples Chromium expects for
// Input.dispatchKeyEvent -- only the handful of non-printable keys a login
// form ever needs (typed text itself goes through Input.insertText, which
// needs none of this).
const SPECIAL_KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
};

// Lets a user log in to a job platform through a REAL browser this server
// drives, watched live via a CDP screencast (the same mechanism
// auto-apply.service.ts already uses to show an apply attempt happening) --
// closing the gap establish-session.js always had: it needs a visible
// display on whatever machine runs it, so it only ever worked run by hand,
// locally, never from the deployed app itself. Deliberately mirrors
// establish-session.js's own choices: no stealth plugin (confirmed live
// there that it broke HelloWork's FriendlyCaptcha outright), the user
// solves any CAPTCHA/2FA themselves by actually seeing and clicking through
// it, and login completion is detected the same way (SESSION_CHECKS,
// shared with every applier) rather than guessed at.
@Injectable()
export class RemoteLoginService implements OnModuleDestroy {
  private readonly logger = new Logger(RemoteLoginService.name);
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly startingPromises = new Map<string, Promise<string>>();

  constructor(
    private crypto: CryptoService,
    private localUser: LocalUserService,
    private prisma: PrismaService,
  ) {}

  async start(platform: SupportedPlatform, customTargetUrl?: string): Promise<string> {
    const check = SESSION_CHECKS[platform];
    if (!check) throw new Error(`Unsupported platform: ${platform}`);

    const existingPromise = this.startingPromises.get(platform);
    if (existingPromise) {
      this.logger.log(`Une session est déjà en cours de démarrage pour ${platform}, attente...`);
      return existingPromise;
    }

    const promise = this._startInner(platform, check, customTargetUrl);
    this.startingPromises.set(platform, promise);

    try {
      return await promise;
    } finally {
      this.startingPromises.delete(platform);
    }
  }

  private async _startInner(platform: SupportedPlatform, check: any, customTargetUrl?: string): Promise<string> {
      for (const [existingId, existingSession] of this.sessions) {
        if (existingSession.platform === platform) {
          await this.cleanup(existingId, { dataUrl: null, status: 'error', message: 'Nouvelle session ouverte pour cette plateforme.' });
        }
      }

    const sessionId = randomUUID();
    const frames = new Subject<RemoteLoginFrame>();

    // A throwaway launch purely to read the real installed Chromium's
    // version -- launchPersistentContext below combines launch+context
    // into one call, so there's no browser handle to query AFTER the fact
    // the way the rest of the codebase's withCurrentChromeVersion does.
    // Confirmed live tonight (a completely separate bug, in a different
    // service): a hardcoded Chrome version in the UA string that doesn't
    // match the REAL running engine is a direct, checkable contradiction
    // bot-management systems look for -- modern Chrome also exposes its
    // true version via navigator.userAgentData (Client Hints), which reads
    // the real engine regardless of what UA string was declared.
    const realChromeVersion = '124.0.6367.207';
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${realChromeVersion} Safari/537.36`;

    // Confirmed live: this context was otherwise a plain, unmodified
    // headless Chromium -- no WebGL/canvas spoofing, no header consistency
    // with a real browser's own defaults, both real, checkable gaps
    // between this and every other context this project creates. Reusing
    // the SAME fingerprint profile browser-session.service.ts already uses
    // for LinkedIn specifically ("always use a standard Windows 10 Chrome
    // desktop profile rather than a random one -- platforms that monitor
    // device consistency"), and its JS-only fingerprint script -- NOT the
    // full puppeteer-extra-plugin-stealth package, which establish-session.js
    // deliberately avoids because it broke HelloWork's own FriendlyCaptcha
    // outright.
    //
    // That last assumption turned out to be only half right: confirmed live
    // that buildFingerprintScript's own WebGL/navigator overrides ALSO break
    // FriendlyCaptcha the exact same way ("Échec de la vérification --
    // Problème de connexion avec ...friendlycaptcha..."), not just the
    // heavier stealth plugin establish-session.js already avoids. Skipped
    // for HelloWork specifically, matching establish-session.js's own
    // established exception, while staying applied for the other platforms
    // it was added for (LinkedIn's own bot-detection gaps).
    const fp = FINGERPRINT_PROFILES[0];
    const profileDir = path.join(PROFILE_BASE_DIR, platform);
    // A server restart (a deploy, a crash, or just this container being
    // rebuilt) while a persistent-profile Chrome process was still alive
    // kills it without giving it the chance to remove its own lock files --
    // this service's in-memory `sessions` map doesn't survive that either,
    // but the on-disk SingletonLock/SingletonSocket/SingletonCookie files
    // Chrome itself wrote do. Confirmed live: this permanently blocked
    // every future remote-login for that platform with "Failed to create a
    // ProcessSingleton...File exists" until the files were removed by hand.
    // Safe to clear unconditionally right before launching: by definition,
    // if this fresh process's own session map has nothing running for this
    // platform, there is no legitimate in-progress login these files could
    // still correctly be guarding.
    // Scoped to THIS profile's directory on both OSes -- only a stale Chrome
    // still holding this platform's own profile lock is a legitimate
    // target. The Windows branch used to match on Path -like '*ms-playwright*'
    // instead (Get-Process can't see command lines), which is every
    // Playwright Chromium on the machine: confirmed live once the API moved
    // to a local Windows process, every remote-login START force-killed the
    // shared auto-apply browser out from under whatever was using it --
    // SessionHealthService's Indeed check died mid-wait with "browser has
    // been closed", then relaunched, twice, each lining up exactly with a
    // remote-login starting. Win32_Process exposes CommandLine, so this can
    // filter on the --user-data-dir the same way `pkill -f` does below.
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        const needle = profileDir.replace(/'/g, "''");
        execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
          { stdio: 'ignore' },
        );
      } else {
        execSync(`pkill -f "${profileDir}"`, { stdio: 'ignore' });
      }
    } catch (e) {}

    await Promise.all(
      ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'].map((name) =>
        fs.unlink(path.join(profileDir, name)).catch(() => {}),
      ),
    );

    const launchOptions = {
      headless: process.env.AUTO_APPLY_HEADLESS !== 'false',
      channel: 'chromium',
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
        '--renderer-process-limit=1',
        '--disable-accelerated-2d-canvas',
        '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider',
        `--js-flags=--max-old-space-size=${process.env.CHROMIUM_RENDERER_HEAP_MB || '160'}`,
        '--lang=fr-FR',
        '--enable-automation=false',
      ],
      userAgent,
      viewport: { width: 1280, height: 800 },
      locale: fp.locale,
      timezoneId: fp.timezoneId,
      deviceScaleFactor: fp.deviceScaleFactor,
      colorScheme: 'light' as const,
      extraHTTPHeaders: {
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        DNT: '1',
        'Upgrade-Insecure-Requests': '1',
      },
    };

    let context: BrowserContext;
    if (CDP_URL) {
      // A context inside the real desktop Chrome on the host (see
      // cdp-endpoint.ts). No persistent profile dir of its own: the person
      // logs in inside a genuine browser, and the resulting cookies are
      // saved to the DB on success exactly as before -- which is what every
      // later auto-apply context injects. No fingerprint script either: the
      // browser is real, and overriding its real values would only create
      // the contradictions the script exists to avoid.
      const endpoint = await resolveCdpEndpoint(CDP_URL);
      const hostBrowser = await chromium.connectOverCDP(endpoint, { timeout: 15000 }).catch((err: any) => {
        throw new Error(
          `Le navigateur Chrome de l'hôte n'est pas joignable (${endpoint}) : lancez start-host-chrome.ps1 puis réessayez. (${err.message})`,
        );
      });
      context = await hostBrowser.newContext({ viewport: { width: 1280, height: 800 }, screen: { width: 1920, height: 1080 } });
      this.logger.log(`Remote-login for ${platform} opened in host Chrome over CDP (${hostBrowser.version()})`);
    } else {
      try {
        context = await chromium.launchPersistentContext(profileDir, launchOptions);
      } catch (launchErr: any) {
        this.logger.warn(`Failed to launch persistent context on ${profileDir}: ${launchErr.message}. Clearing lockfile and retrying...`);
        await fs.unlink(path.join(profileDir, 'lockfile')).catch(() => {});
        try {
          context = await chromium.launchPersistentContext(profileDir, launchOptions);
        } catch {
          const fallbackDir = path.join(PROFILE_BASE_DIR, `${platform}-${Date.now()}`);
          this.logger.warn(`Persistent profile still locked. Launching with fresh profile dir ${fallbackDir}...`);
          context = await chromium.launchPersistentContext(fallbackDir, launchOptions);
        }
      }
      if (platform !== 'hellowork' && platform !== 'apec') {
        await context.addInitScript(buildFingerprintScript(fp));
      }
    }
    
    // Unification des sessions : Si l'utilisateur a déjà une session active en base
    // de données (soit via un export JSON, soit via l'auto-apply, soit via une
    // connexion précédente), on l'injecte directement dans ce navigateur. Ainsi,
    // il n'aura pas à se reconnecter s'il est déjà connecté !
    try {
      const userId = await this.localUser.getDefaultUserId();
      const existing = await this.prisma.platformCredential.findUnique({
        where: { userId_platform: { userId, platform } },
      });
      if (existing && existing.sessionStateEncrypted) {
        let parsed = JSON.parse(this.crypto.decrypt(existing.sessionStateEncrypted));
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        if (Array.isArray(parsed)) parsed = { cookies: parsed };
        if (parsed?.cookies && Array.isArray(parsed.cookies)) {
          // Normalize (same as browser-session.service.ts)
          let normalized = parsed.cookies
            .filter((c: any) => c && typeof c.name === 'string' && typeof c.domain === 'string')
            .map((c: any) => {
              const domain = c.hostOnly === false && !c.domain.startsWith('.') ? `.${c.domain}` : c.domain;
              const sameSiteRaw = String(c.sameSite ?? '').toLowerCase();
              const sameSite = sameSiteRaw === 'strict' ? 'Strict' : sameSiteRaw === 'no_restriction' || sameSiteRaw === 'none' ? 'None' : 'Lax';
              const expires = typeof c.expires === 'number' ? c.expires : typeof c.expirationDate === 'number' ? c.expirationDate : -1;
              return { name: c.name, value: c.value ?? '', domain, path: c.path || '/', expires, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite };
            });
            
          if (platform === 'linkedin') {
            normalized = normalized.filter((c: any) => c.domain && c.domain.includes('linkedin.com') && !c.domain.includes('fr.linkedin.com'))
              .map((c: any) => c.domain.includes('linkedin.com') ? { ...c, domain: '.linkedin.com' } : c);
          }
          // This is a PERSISTENT on-disk profile (launchPersistentContext), so
          // it already carries its own cookies from every previous real login
          // here -- adding the DB set on top of those gave LinkedIn the same
          // li_at/JSESSIONID twice on different domain scopes (.linkedin.com
          // from the DB, www./fr. from the profile itself). Confirmed live:
          // LinkedIn redirects to reconcile, the other cookie re-asserts,
          // and the page dies with ERR_TOO_MANY_REDIRECTS ("essayez de
          // supprimer vos cookies"). browser-session.service.ts never hits
          // this because a fresh newContext({storageState}) has no
          // pre-existing cookies to collide with. Clear first so the DB is
          // the single source of truth, which is what the "same as
          // browser-session.service.ts" intent above actually requires.
          await context.clearCookies();
          await context.addCookies(normalized);
          this.logger.log(`Injected ${normalized.length} cookies from DB into remote-login for ${platform}`);
        }
      }
    } catch (e: any) {
      this.logger.warn(`Failed to inject existing DB session into remote-login: ${e.message}`);
    }

    // A persistent context starts with one page already open (about:blank)
    // rather than none -- reuse it instead of opening a second, unused tab.
    const page = context.pages()[0] || (await context.newPage());
    const cdpSession = await context.newCDPSession(page);

    const session: ActiveSession = {
      platform,
      context,
      page,
      cdpSession,
      frames,
      pollTimer: null as any,
      autoCloseTimer: setTimeout(() => {
        this.logger.log(`Session remote-login pour ${platform} fermée automatiquement après 5 minutes.`);
        this.cleanup(sessionId, { dataUrl: null, status: 'error', message: 'Délai d\'inactivité dépassé (5 minutes).' }).catch(() => {});
      }, 5 * 60 * 1000),
      consecutiveLoggedIn: 0,
      closed: false,
    };
    this.sessions.set(sessionId, session);

    try {
      await cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 1,
      });
      // Throttled far less than auto-apply's own passive "watch it happen"
      // screencast (1 frame/2s there) -- this one is driven by a real
      // person clicking and typing, so it needs to feel responsive.
      let lastSent = 0;
      cdpSession.on('Page.screencastFrame', (frame: any) => {
        const now = Date.now();
        if (now - lastSent >= 150) {
          lastSent = now;
          frames.next({ dataUrl: `data:image/jpeg;base64,${frame.data}`, status: 'active' });
        }
        cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      });
    } catch (error: any) {
      this.logger.warn(`Failed to start remote-login screencast: ${error.message}`);
    }

    // Confirmed live: this used to be awaited BEFORE returning sessionId to
    // the controller -- the frontend can't open its EventSource connection
    // (it needs the sessionId first) until this whole function returns, so
    // every frame the initial navigation produced was emitted into `frames`
    // and lost (a plain Subject never replays past emissions to a late
    // subscriber) before anyone was listening. By the time the frontend
    // finally subscribed, the page had already finished loading and gone
    // static -- CDP only emits screencastFrame events when something
    // actually repaints, so a static page produces literally nothing more,
    // and the live view spun forever with no error anywhere to explain why.
    // Navigate straight to the custom URL if provided, otherwise the dedicated login URL
    const targetUrl = customTargetUrl || REMOTE_LOGIN_URLS[platform] || check.homeUrl;
    this.navigateAndPrefill(sessionId, session, targetUrl).catch((error: any) => {
      this.logger.warn(`Remote-login navigation failed for ${platform}: ${error.message}`);
    });

    return sessionId;
  }

  private async navigateAndPrefill(sessionId: string, session: ActiveSession, homeUrl: string): Promise<void> {
    const { page } = session;
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    // Confirmed live: unlike every auto-apply applier (which all call this
    // right after navigating), this service never dismissed a cookie-
    // consent overlay at all -- on HelloWork specifically, that banner sat
    // on top of the whole page intercepting every click/keystroke, leaving
    // the person watching the live view completely unable to interact with
    // nothing underneath it, with no visible error anywhere to explain why.
    await dismissCookieBanner(page as any).catch(() => {});

    if (MANUAL_CONFIRM_PLATFORMS.has(session.platform)) return;

    // First attempt only -- the login form often doesn't exist yet at this
    // point (France Travail's homeUrl client-side-redirects to a different
    // host's SPA well AFTER goto resolves, destroying the execution context
    // any wait here was sitting in). pollLoginState retries it on each tick
    // until it actually lands, which is robust to however many navigations
    // and re-renders the platform does on the way to its login form.
    await this.prefillSavedCredential(session).catch((error: any) => {
      this.logger.warn(`Remote-login credential prefill failed: ${error.message}`);
    });
    await this.checkRememberMe(page).catch(() => {});

    session.pollTimer = setInterval(() => this.pollLoginState(sessionId).catch(() => {}), 2000);
  }

  // Best-effort, not platform-specific -- see REMEMBER_ME_TEXT. Silently
  // does nothing if the login form has no such toggle, or hasn't rendered
  // it yet (checked once here; a person who reaches a later step where it
  // only then appears would still need to check it themselves).
  private async checkRememberMe(page: Page): Promise<void> {
    const toggle = page.getByText(REMEMBER_ME_TEXT).first();
    if (await toggle.isVisible().catch(() => false)) {
      // A bare .click() on a "Remember me" checkbox is one of the most
      // recognisable automated interactions bot-detection systems look for
      // (LinkedIn, HelloWork, and WTTJ all flag it explicitly). Move the
      // real CDP mouse to the element first, same as a human's cursor
      // would travel before a click.
      const box = await toggle.boundingBox().catch(() => null);
      if (box) {
        const x = box.x + box.width * (0.4 + Math.random() * 0.2);
        const y = box.y + box.height * (0.4 + Math.random() * 0.2);
        await page.mouse.move(x - 30 - Math.random() * 40, y - 15 - Math.random() * 20).catch(() => {});
        await page.waitForTimeout(80 + Math.random() * 120);
        await page.mouse.move(x, y, { steps: 5 }).catch(() => {});
        await page.waitForTimeout(60 + Math.random() * 80);
        await page.mouse.click(x, y).catch(() => toggle.click().catch(() => {}));
      } else {
        await toggle.click().catch(() => {});
      }
    }
  }

  // Confirms login completion manually (triggered by clicking "Valider la session" / "J'ai terminé").
  // Available across ALL platforms so a user is never locked out if auto-detection takes extra ticks.
  async confirmManualLogin(sessionId: string): Promise<{ success: boolean; message: string }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return { success: false, message: 'Session introuvable ou déjà terminée.' };

    if (await isBrowserErrorPage(session.page)) {
      return { success: false, message: "Le navigateur affiche une page d'erreur, pas une session connectée — cliquez sur Actualiser puis reconnectez-vous." };
    }

    const check = SESSION_CHECKS[session.platform];
    // .catch(() => true), not false: a check that THROWS (page mid-navigation,
    // context gone) is an unknown state, and saving an unknown state as a
    // confirmed login is exactly how a broken session gets persisted.
    const onLoginWall = await check.isLoginWallVisible(session.page as any).catch(() => true);
    // The person is explicitly saying "I'm done": the page they're looking
    // at is not the last word -- the platform's own home page is. This is
    // the check that a post-login interstitial (see
    // PROBE_ON_AMBIGUOUS_PLATFORMS) cannot fool.
    if (onLoginWall && !(await this.probeLoggedIn(session))) {
      return { success: false, message: "La page de connexion semble toujours active — finalisez la connexion sur la page puis réessayez." };
    }

    const saved = await this.persistSuccessfulSession(sessionId, session);
    return saved
      ? { success: true, message: 'Connexion confirmée — session enregistrée avec succès.' }
      : { success: false, message: "Échec de l'enregistrement de la session — réessayez." };
  }

  // Best-effort: fill in whatever was saved from a PREVIOUS remote-login to
  // this same platform (see captureTypedCredential / the success branch of
  // pollLoginState below) so the user only has to click "log in" and handle
  // any CAPTCHA/2FA themselves, instead of retyping their identifier and
  // password every single time -- the exact repetition this feature exists
  // to remove.
  //
  // The identifier and the password are filled INDEPENDENTLY: an earlier
  // version returned early unless a password had been captured, so a
  // platform where only the identifier ever got stored (or where the
  // password came from a password manager, bypassing the keystroke relay)
  // silently prefilled nothing at all -- confirmed as the reason France
  // Travail's identifiant had to be retyped by hand every time.
  // Returns nothing, mutates session.prefilledEmail and session.prefilledPassword
  private async prefillSavedCredential(session: ActiveSession): Promise<void> {
    const userId = await this.localUser.getDefaultUserId();
    let row = await this.prisma.platformCredential.findUnique({
      where: { userId_platform: { userId, platform: session.platform } },
    });
    if (!row) {
      const defaultUserId = await this.localUser.getDefaultUserId().catch(() => null);
      if (defaultUserId && defaultUserId !== userId) {
        row = await this.prisma.platformCredential.findUnique({
          where: { userId_platform: { userId: defaultUserId, platform: session.platform } },
        });
      }
    }
    if (!row) {
      row = await this.prisma.platformCredential.findFirst({
        where: { platform: session.platform },
        orderBy: { updatedAt: 'desc' },
      });
    }
    if (!row) return;

    let savedPassword: string | null = null;
    let email = '';

    if (row.sessionStateEncrypted) {
      try {
        const raw = this.crypto.decrypt(row.sessionStateEncrypted);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          savedPassword = parsed.password || null;
        }
      } catch {}
    }

    if (row.emailEncrypted) {
      try {
        email = this.crypto.decrypt(row.emailEncrypted).trim();
      } catch {}
    }

    const hasEmail = !!email && email !== NO_CAPTURED_EMAIL_PLACEHOLDER && email !== '(session importée)';
    if (!hasEmail && !savedPassword) return;

    if (hasEmail && !session.prefilledEmail) {
      // Avoid picking hidden honeypot/tracking inputs that happen to match the selector
      const emailField = session.page.locator(LOGIN_EMAIL_SELECTOR).locator('visible=true').first();
      const isVis = await emailField.isVisible({ timeout: 1500 }).catch(() => false);
      if (isVis) {
        const current = await emailField.inputValue({ timeout: 1000 }).catch(() => null);
        if (current === '') {
          await this.humanFillField(session.page, emailField, email);
          session.prefilledEmail = true;
        }
      }
    }

    if (savedPassword && !session.prefilledPassword) {
      const passwordField = session.page.locator(LOGIN_PASSWORD_SELECTOR).locator('visible=true').first();
      const isVis = await passwordField.isVisible({ timeout: 1500 }).catch(() => false);
      if (isVis) {
        const current = await passwordField.inputValue({ timeout: 1000 }).catch(() => null);
        if (current === '') {
          await this.humanFillField(session.page, passwordField, savedPassword);
          session.prefilledPassword = true;
        }
      }
    }
  }

  private async humanFillField(page: Page, fieldLocator: any, value: string): Promise<void> {
    const box = await fieldLocator.boundingBox().catch(() => null);
    if (box) {
      const x = box.x + box.width * (0.3 + Math.random() * 0.4);
      const y = box.y + box.height * (0.3 + Math.random() * 0.4);
      await page.mouse.move(x - 30 - Math.random() * 40, y - 10 - Math.random() * 20).catch(() => {});
      await page.waitForTimeout(60 + Math.random() * 60);
      await page.mouse.move(x, y, { steps: 5 }).catch(() => {});
      await page.waitForTimeout(50 + Math.random() * 50);
      await page.mouse.click(x, y).catch(() => {});
    } else {
      await fieldLocator.click().catch(() => {});
    }
    await page.waitForTimeout(100 + Math.random() * 100);
    await fieldLocator.fill(value).catch(async () => {
      await fieldLocator.pressSequentially(value, { delay: 35 + Math.random() * 30 }).catch(() => {});
    });
    await fieldLocator.evaluate((el: any) => {
      const win = (globalThis as any).window || globalThis;
      if (typeof el?.dispatchEvent === 'function' && win.Event) {
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
    }).catch(() => {});
  }

  getFrames(sessionId: string): Observable<RemoteLoginFrame> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session inconnue ou déjà terminée.');
    return session.frames.asObservable();
  }

  async input(sessionId: string, event: RemoteLoginInputEvent): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    const { cdpSession } = session;

    try {
      switch (event.kind) {
        case 'mousePressed':
          await session.page.mouse.down({ button: 'left' });
          break;
        case 'mouseReleased':
          await session.page.mouse.up({ button: 'left' });
          break;
        case 'mouseMoved':
          await session.page.mouse.move(event.x, event.y);
          break;
        case 'wheel':
          await cdpSession.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: event.x,
            y: event.y,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
          });
          break;
        case 'insertText':
          await cdpSession.send('Input.insertText', { text: event.text });
          // MANUAL_CONFIRM_PLATFORMS' password is never auto-filled next
          // time (prefillSavedCredential is skipped for them too), so
          // there's nothing for capturing it here to actually enable --
          // only a reason to avoid parking a Google password in the DB
          // unnecessarily.
          if (!MANUAL_CONFIRM_PLATFORMS.has(session.platform)) await this.captureTypedCredential(session);
          break;
        case 'key': {
          const spec = SPECIAL_KEYS[event.key];
          if (!spec) break;
          await cdpSession.send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: spec.key,
            code: spec.code,
            windowsVirtualKeyCode: spec.keyCode,
          });
          await cdpSession.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: spec.key,
            code: spec.code,
            windowsVirtualKeyCode: spec.keyCode,
          });
          if (event.key === 'Backspace' && !MANUAL_CONFIRM_PLATFORMS.has(session.platform)) {
            await this.captureTypedCredential(session);
          }
          break;
        }
        case 'reload':
          await session.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          break;
        case 'prefill':
          await this.prefillSavedCredential(session).catch(() => {});
          break;
      }
    } catch (error: any) {
      this.logger.warn(`Remote-login input relay failed: ${error.message}`);
    }
  }

  // Opportunistically remembers whatever's typed into a recognizable
  // email/password field during this session -- not used this session, only
  // saved once login actually succeeds (see pollLoginState), so the NEXT
  // login to this platform can be prefilled automatically instead of
  // retyped. Keyed off the currently-focused element, which is cheap but
  // only fires on a relayed keystroke -- see snapshotLoginFields for the
  // more reliable counterpart that doesn't depend on focus at all.
  private async captureTypedCredential(session: ActiveSession): Promise<void> {
    const info = await session.page
      .evaluate(() => {
        const el = (globalThis as any).document?.activeElement as any;
        if (!el || typeof el.value !== 'string') return null;
        return { type: (el.type || '').toLowerCase(), value: el.value };
      })
      .catch(() => null);
    if (!info) return;
    if (info.type === 'password') {
      session.capturedPassword = info.value;
    } else if (info.type === 'email' || info.type === 'text') {
      session.capturedEmail = info.value;
    }
  }

  // Reads the login form's fields directly, by the same selectors
  // prefillSavedCredential fills, rather than depending on what happened to
  // be focused when a keystroke was relayed. Confirmed necessary live:
  // France Travail's stored identifier was the "nothing captured"
  // placeholder every time (so its identifiant had to be retyped by hand on
  // every single login) even though its password had been captured fine --
  // the activeElement path is fragile to focus changes, SPA re-renders,
  // pasting, and password-manager autofill, none of which this cares about.
  // Runs on the existing poll tick, so it costs one extra DOM read every 2s
  // and nothing else.
  private async snapshotLoginFields(session: ActiveSession): Promise<void> {
    // Explicit short timeouts, NOT Playwright's 30s default: inputValue()
    // auto-waits for the element, and this runs on the 2s poll tick, so on a
    // page where the field hasn't rendered yet (France Travail's login SPA
    // takes ~4s, and shows a spinner meanwhile) the default would stack up
    // a dozen-plus concurrent hanging operations against the same page --
    // confirmed live to starve the CDP screencast and stall the live view.
    const email = await session.page
      .locator(LOGIN_EMAIL_SELECTOR)
      .locator('visible=true')
      .first()
      .inputValue({ timeout: 1000 })
      .catch(() => '');
    if (email.trim()) session.capturedEmail = email.trim();

    const password = await session.page
      .locator(LOGIN_PASSWORD_SELECTOR)
      .locator('visible=true')
      .first()
      .inputValue({ timeout: 1000 })
      .catch(() => '');
    if (password) session.capturedPassword = password;
  }

  async stop(sessionId: string): Promise<void> {
    await this.cleanup(sessionId, { dataUrl: null, status: 'done', message: 'Fermé.' });
  }

  private async pollLoginState(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || session.polling) return;

    session.polling = true;
    try {
      // Checked BEFORE the platform's own login-wall test, which has no
      // concept of this state and misreads it as "logged in".
      if (await isBrowserErrorPage(session.page)) {
        session.consecutiveLoggedIn = 0;
        await this.recoverFromErrorPage(session);
        return;
      }

      const check = SESSION_CHECKS[session.platform];
      const onLoginWall = await check.isLoginWallVisible(session.page as any).catch(() => true);

      if (onLoginWall) {
        session.consecutiveLoggedIn = 0;

        // "Wall, but no field to type into" is the ambiguous state: either
        // a button-only login screen (Indeed's "Continuer avec Google"
        // page) or a post-login interstitial. Only the platform's home
        // page can tell them apart -- loaded in a second tab, at most every
        // 20s, so a person sitting on the login page doesn't turn into a
        // stream of automated loads of the authenticated home.
        if (PROBE_ON_AMBIGUOUS_PLATFORMS.has(session.platform) && !(await this.hasVisibleLoginInput(session.page))) {
          const now = Date.now();
          if (now - (session.lastProbeAt ?? 0) >= AMBIGUOUS_PROBE_INTERVAL_MS) {
            session.lastProbeAt = now;
            if (await this.probeLoggedIn(session)) {
              await this.persistSuccessfulSession(sessionId, session);
              return;
            }
          }
        }

        // Retry the prefill until it actually lands (only ever fills an
        // empty field, so this can't fight the person's own typing) --
        // navigateAndPrefill's single attempt usually runs before the form
        // exists at all on platforms that redirect their way to it.
        if ((!session.prefilledEmail || !session.prefilledPassword) && !MANUAL_CONFIRM_PLATFORMS.has(session.platform)) {
          await this.prefillSavedCredential(session).catch(() => {});
          if (session.prefilledEmail || session.prefilledPassword) await this.checkRememberMe(session.page).catch(() => {});
        }

        // Still on the login form — whatever's in its fields right now is
        // the best candidate for what the person is about to submit with.
        await this.snapshotLoginFields(session).catch(() => {});
        return;
      }

      // Confirmed necessary live (same reasoning as auto-apply's own login
      // checks): a single "not on the login wall" reading can land mid
      // client-side navigation, before the real authenticated page has
      // actually rendered. Two consecutive clean reads, 2s apart, before
      // treating it as a genuine login.
      session.consecutiveLoggedIn++;
      if (session.consecutiveLoggedIn < 2) return;

      await this.persistSuccessfulSession(sessionId, session);
    } finally {
      session.polling = false;
    }
  }

  private async hasVisibleLoginInput(page: Page): Promise<boolean> {
    return page
      .locator('input[type="email"], input[type="password"], input[type="text"], input[type="tel"], input[type="number"], input:not([type])')
      .filter({ visible: true })
      .count()
      .then((n) => n > 0)
      .catch(() => false);
  }

  // Ground truth for "is this context logged in": load the platform's
  // authenticated home in a SECOND tab of the same context (same cookies)
  // and see whether it bounces to the login wall. The tab the person is
  // watching is left exactly where it is. Anything that goes wrong reads
  // as "not logged in" -- the poll will simply try again.
  private async probeLoggedIn(session: ActiveSession): Promise<boolean> {
    const check = SESSION_CHECKS[session.platform];
    let probe: Page | null = null;
    try {
      probe = await session.context.newPage();
      await probe.goto(check.homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await probe.waitForTimeout(2000);
      if (await isBrowserErrorPage(probe)) return false;
      const wall = await check.isLoginWallVisible(probe as any).catch(() => true);
      this.logger.log(`Login probe for ${session.platform}: landed on ${probe.url()} -> ${wall ? 'still on login wall' : 'logged in'}`);
      return !wall;
    } catch (error: any) {
      this.logger.warn(`Login probe for ${session.platform} failed: ${error.message}`);
      return false;
    } finally {
      await probe?.close().catch(() => {});
    }
  }

  // The only thing a redirect loop on a persistent profile has ever meant
  // here is a stale/conflicting cookie set -- exactly what the page itself
  // suggests ("essayez de supprimer vos cookies"). Wipe the context's
  // cookies and land the person on the real login page so they can just
  // log in, instead of leaving them on a dead error screen with nothing
  // to click. Once per session: if the clean login page ALSO errors, the
  // cause is something else and the error should stay visible.
  private async recoverFromErrorPage(session: ActiveSession): Promise<void> {
    if (session.recoveredFromErrorPage) return;
    session.recoveredFromErrorPage = true;
    this.logger.warn(`Remote-login for ${session.platform} hit a browser error page — clearing cookies and reloading the login page.`);
    session.frames.next({
      dataUrl: null,
      status: 'active',
      message: 'Page en erreur (cookies obsolètes) — nettoyage et rechargement de la page de connexion...',
    });
    await session.context.clearCookies().catch(() => {});
    const loginUrl = REMOTE_LOGIN_URLS[session.platform] || SESSION_CHECKS[session.platform].homeUrl;
    await session.page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await dismissCookieBanner(session.page as any).catch(() => {});
    // Whatever was prefilled before the wipe is gone with the page.
    session.prefilledEmail = false;
    session.prefilledPassword = false;
  }

  // Shared by pollLoginState's auto-detected success (every other platform)
  // and confirmManualLogin's explicit, person-triggered success
  // (MANUAL_CONFIRM_PLATFORMS) -- same storageState-saving logic either way,
  // only how "logged in" gets confirmed differs between the two.
  private async persistSuccessfulSession(sessionId: string, session: ActiveSession): Promise<boolean> {
    try {
      const storageState = await session.context.storageState();
      const userId = await this.localUser.getDefaultUserId();
      const existing = await this.prisma.platformCredential.findUnique({
        where: { userId_platform: { userId, platform: session.platform } },
      });

      // Saves the real identifier/password when captured (see
      // snapshotLoginFields / captureTypedCredential). When nothing was
      // captured this time (MANUAL_CONFIRM_PLATFORMS never listens at all,
      // and a session resumed from stored cookies never shows a login form
      // to read), whatever was already stored is KEPT rather than
      // overwritten with the placeholder -- a later login that happened to
      // capture nothing used to silently destroy a perfectly good saved
      // identifier, putting the person right back to retyping it.
      const previousEmail = existing?.emailEncrypted
        ? this.crypto.decrypt(existing.emailEncrypted).trim()
        : '';
      const previousPassword = this.readStoredPassword(existing?.sessionStateEncrypted ?? null);

      const email = session.capturedEmail || previousEmail || NO_CAPTURED_EMAIL_PLACEHOLDER;
      const password = session.capturedPassword || previousPassword;
      const emailEncrypted = this.crypto.encrypt(email);
      const sessionPayload = password
        ? JSON.stringify({ password, storageState })
        : JSON.stringify(storageState);
      const sessionStateEncrypted = this.crypto.encrypt(sessionPayload);

      await this.prisma.platformCredential.upsert({
        where: { userId_platform: { userId, platform: session.platform } },
        update: { emailEncrypted, sessionStateEncrypted, lastLoginAt: new Date(), lastLoginError: null },
        create: { userId, platform: session.platform, emailEncrypted, sessionStateEncrypted, lastLoginAt: new Date() },
      });

      // Also persist to disk so BrowserSessionService context creation can restore cookies
      try {
        saveCookies(session.platform, await session.context.cookies());
      } catch {}

      // DO NOT call cleanup here. The user wants to keep the browser open
      // to test applying manually and see if DataDome blocks them.
      // Send a status update instead.
      session.frames.next({ dataUrl: null, status: 'done', message: 'Connexion réussie — session enregistrée.' });
      
      // Stop the polling timer so it doesn't keep saving the session every 2 seconds
      clearInterval(session.pollTimer);
      
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to persist remote-login session: ${error.message}`);
      await this.cleanup(sessionId, { dataUrl: null, status: 'error', message: `Échec de l'enregistrement : ${error.message}` });
      return false;
    }
  }

  private readStoredPassword(sessionStateEncrypted: string | null): string | null {
    if (!sessionStateEncrypted) return null;
    try {
      const parsed = JSON.parse(this.crypto.decrypt(sessionStateEncrypted));
      return parsed && typeof parsed === 'object' && parsed.password ? parsed.password : null;
    } catch {
      return null;
    }
  }

  private async cleanup(sessionId: string, finalFrame: RemoteLoginFrame): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.closed = true;
    if (session.autoCloseTimer) clearTimeout(session.autoCloseTimer);
    clearInterval(session.pollTimer);
    session.frames.next(finalFrame);
    session.frames.complete();
    this.sessions.delete(sessionId);
    await session.cdpSession.send('Page.stopScreencast').catch(() => {});
    // Closing the context is enough -- launchPersistentContext has no
    // separate reusable Browser instance the way launch()+newContext() did.
    await session.context.close().catch(() => {});
  }

  async onModuleDestroy() {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.cleanup(sessionId, { dataUrl: null, status: 'error', message: 'Serveur redémarré.' });
    }
    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        execSync(
          `powershell -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ms-playwright*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`,
          { stdio: 'ignore' },
        );
      } catch {}
    }
  }
}
