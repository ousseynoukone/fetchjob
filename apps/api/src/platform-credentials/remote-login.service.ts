import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { chromium } from 'playwright';
import type { BrowserContext, Page, CDPSession } from 'playwright';
import { Subject, Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import { CryptoService } from '../common/crypto.service';
import { LocalUserService } from '../common/local-user.service';
import { PrismaService } from '../common/prisma.service';
import { SESSION_CHECKS } from '../auto-apply/appliers/ats-common';
import { buildFingerprintScript, FINGERPRINT_PROFILES } from '../scraping/stealth-browser';
import { SupportedPlatform } from './dto/upsert-credential.dto';

// Docker-volume-backed (see docker-compose.yml) so a real, accumulating
// Chrome profile per platform survives container restarts/rebuilds instead
// of starting from a completely blank, zero-history browser on every single
// login attempt -- confirmed live that a real person's own repeat login was
// recognized as a trusted device/location by LinkedIn itself once the other
// fingerprint gaps were closed, and a persistent profile is the next step
// toward "looks like the same returning browser" rather than "looks new
// every time". Not backed by a persistent volume on Render's free tier
// (no such thing there), so this only actually helps local testing today.
const PROFILE_BASE_DIR = process.env.REMOTE_LOGIN_PROFILE_DIR || '/root/.findurjob/remote-login-profiles';

export interface RemoteLoginFrame {
  dataUrl: string | null;
  status: 'active' | 'done' | 'error';
  message?: string;
}

export type RemoteLoginInputEvent =
  | { kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'insertText'; text: string }
  | { kind: 'key'; key: 'Enter' | 'Backspace' | 'Tab' | 'Escape' };

interface ActiveSession {
  platform: SupportedPlatform;
  context: BrowserContext;
  page: Page;
  cdpSession: CDPSession;
  frames: Subject<RemoteLoginFrame>;
  pollTimer: NodeJS.Timeout;
  consecutiveLoggedIn: number;
  closed: boolean;
  // Best-effort capture of whatever the user types into the login form
  // during this session -- not read back this session, only saved once
  // login succeeds so the NEXT login to this same platform can be
  // pre-filled instead of retyped from scratch (see prefillSavedCredential).
  capturedEmail?: string;
  capturedPassword?: string;
}

// Generic enough to match every platform's own login form without needing a
// per-platform selector map: an email/identifier-like field, and any
// password field. Used both to auto-fill a previously-saved credential
// (prefillSavedCredential) and to recognize which field the user is
// currently typing into (captureTypedCredential).
const LOGIN_EMAIL_SELECTOR =
  'input[type="email"], input[autocomplete*="username" i], input[name*="email" i], input[id*="email" i], input[name*="identifiant" i], input[id*="identifiant" i], input[name="__email"]';
const LOGIN_PASSWORD_SELECTOR = 'input[type="password"]';
// Written when nothing was captured for the login identifier (see
// captureTypedCredential) -- checked against by name, not by shape (an `@`
// test), since not every platform's login identifier is an email address.
// France Travail in particular logs in with a plain "identifiant" that has
// no reason to contain one.
const NO_CAPTURED_EMAIL_PLACEHOLDER = '(connecté via navigateur intégré)';

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

  constructor(
    private crypto: CryptoService,
    private localUser: LocalUserService,
    private prisma: PrismaService,
  ) {}

  async start(platform: SupportedPlatform): Promise<string> {
    const check = SESSION_CHECKS[platform];
    if (!check) throw new Error(`Unsupported platform: ${platform}`);

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
    const versionProbe = await chromium.launch({ headless: true, channel: 'chromium' });
    const realChromeVersion = versionProbe.version();
    await versionProbe.close();
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
    // outright; buildFingerprintScript only overrides navigator/WebGL
    // properties, nothing that should interfere with a real person solving
    // a real CAPTCHA/2FA prompt themselves through the live view.
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
    await Promise.all(
      ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].map((name) =>
        fs.unlink(path.join(profileDir, name)).catch(() => {}),
      ),
    );
    // launchPersistentContext, not launch()+newContext() -- a real, on-disk
    // Chrome profile PER PLATFORM (cookies, cache, local storage) that
    // survives across every future login attempt to that same platform
    // instead of starting from a completely blank, zero-history browser
    // every single time, which is itself a signal a real person's browser
    // never gives off. See PROFILE_BASE_DIR above for the persistence
    // caveat (local only, not on Render's free tier).
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      channel: 'chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--lang=fr-FR',
      ],
      userAgent,
      // Fixed at 1280x800, NOT fp.viewport (1920x1080) -- the frontend's
      // click/wheel coordinate mapping is hardcoded to this exact size to
      // match the CDP screencast's own maxWidth/maxHeight below; using the
      // fingerprint profile's own viewport here would silently break every
      // click's position without erroring anywhere.
      viewport: { width: 1280, height: 800 },
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
    await context.addInitScript(buildFingerprintScript(fp));
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

    await page.goto(check.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    await this.prefillSavedCredential(session).catch((error: any) => {
      this.logger.warn(`Remote-login credential prefill failed: ${error.message}`);
    });

    session.pollTimer = setInterval(() => this.pollLoginState(sessionId).catch(() => {}), 2000);

    return sessionId;
  }

  // Best-effort: if a password was saved from a PREVIOUS remote-login to
  // this same platform (see captureTypedCredential / the success branch of
  // pollLoginState below), fill it in automatically so the user only has to
  // click "log in" and handle any CAPTCHA/2FA themselves, instead of typing
  // their email and password again every single time -- the exact
  // repetition this feature exists to remove. Silently does nothing if
  // there's no saved password yet (first login to a platform), or if the
  // login form's fields don't match the generic selectors above.
  private async prefillSavedCredential(session: ActiveSession): Promise<void> {
    const userId = await this.localUser.getDefaultUserId();
    const row = await this.prisma.platformCredential.findUnique({
      where: { userId_platform: { userId, platform: session.platform } },
    });
    if (!row?.sessionStateEncrypted) return;

    const raw = this.crypto.decrypt(row.sessionStateEncrypted);
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // A session-only credential (established via the old establish-session.js
    // script, or a previous remote-login where nothing was captured) stores
    // the raw storageState with no `password` key -- nothing to prefill.
    if (!parsed || typeof parsed !== 'object' || !parsed.password) return;

    const email = row.emailEncrypted ? this.crypto.decrypt(row.emailEncrypted) : '';
    // Login forms on these platforms are all client-rendered SPAs -- a
    // fixed settle delay here, same reasoning as fillIdentityFields'
    // own wait between passes, since filling before the field exists is a
    // silent no-op with no error to catch.
    await session.page.waitForTimeout(1500);

    if (email && email !== NO_CAPTURED_EMAIL_PLACEHOLDER) {
      const emailField = session.page.locator(LOGIN_EMAIL_SELECTOR).first();
      if (await emailField.isVisible().catch(() => false)) {
        await emailField.fill(email).catch(() => {});
      }
    }
    const passwordField = session.page.locator(LOGIN_PASSWORD_SELECTOR).first();
    if (await passwordField.isVisible().catch(() => false)) {
      await passwordField.fill(parsed.password).catch(() => {});
    }
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
        case 'mouseReleased':
        case 'mouseMoved':
          await cdpSession.send('Input.dispatchMouseEvent', {
            type: event.kind,
            x: event.x,
            y: event.y,
            button: 'left',
            clickCount: event.kind === 'mousePressed' ? 1 : 0,
          });
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
          await this.captureTypedCredential(session);
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
          if (event.key === 'Backspace') await this.captureTypedCredential(session);
          break;
        }
      }
    } catch (error: any) {
      this.logger.warn(`Remote-login input relay failed: ${error.message}`);
    }
  }

  // Opportunistically remembers whatever's typed into a recognizable
  // email/password field during this session -- not used this session, only
  // saved once login actually succeeds (see pollLoginState), so the NEXT
  // login to this platform can be prefilled automatically instead of
  // retyped. Keyed off the currently-focused element rather than parsing
  // the whole page every keystroke; a login page realistically never has
  // another free-text field to confuse this with.
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

  async stop(sessionId: string): Promise<void> {
    await this.cleanup(sessionId, { dataUrl: null, status: 'done', message: 'Fermé.' });
  }

  private async pollLoginState(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;

    const check = SESSION_CHECKS[session.platform];
    const onLoginWall = await check.isLoginWallVisible(session.page).catch(() => true);

    if (onLoginWall) {
      session.consecutiveLoggedIn = 0;
      return;
    }

    // Confirmed necessary live (same reasoning as auto-apply's own login
    // checks): a single "not on the login wall" reading can land mid
    // client-side navigation, before the real authenticated page has
    // actually rendered. Two consecutive clean reads, 2s apart, before
    // treating it as a genuine login.
    session.consecutiveLoggedIn++;
    if (session.consecutiveLoggedIn < 2) return;

    try {
      const storageState = await session.context.storageState();
      const userId = await this.localUser.getDefaultUserId();
      // Saves the real typed email/password when captured (see
      // captureTypedCredential) instead of the old placeholder label, so
      // prefillSavedCredential has something real to work with on the NEXT
      // login to this platform. Falls back to the placeholder + raw
      // storageState-only shape when nothing was captured (e.g. a password
      // manager/autofill extension typed it, bypassing the keystroke relay
      // entirely) -- exactly today's existing behavior, not a regression.
      const email = session.capturedEmail || NO_CAPTURED_EMAIL_PLACEHOLDER;
      const emailEncrypted = this.crypto.encrypt(email);
      const sessionPayload = session.capturedPassword
        ? JSON.stringify({ password: session.capturedPassword, storageState })
        : JSON.stringify(storageState);
      const sessionStateEncrypted = this.crypto.encrypt(sessionPayload);

      await this.prisma.platformCredential.upsert({
        where: { userId_platform: { userId, platform: session.platform } },
        update: { emailEncrypted, sessionStateEncrypted, lastLoginAt: new Date(), lastLoginError: null },
        create: { userId, platform: session.platform, emailEncrypted, sessionStateEncrypted, lastLoginAt: new Date() },
      });

      await this.cleanup(sessionId, { dataUrl: null, status: 'done', message: 'Connexion réussie — session enregistrée.' });
    } catch (error: any) {
      this.logger.error(`Failed to persist remote-login session: ${error.message}`);
      await this.cleanup(sessionId, { dataUrl: null, status: 'error', message: `Échec de l'enregistrement : ${error.message}` });
    }
  }

  private async cleanup(sessionId: string, finalFrame: RemoteLoginFrame): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.closed = true;
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
  }
}
