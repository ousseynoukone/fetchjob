import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, CDPSession } from 'playwright';
import { Subject, Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import { CryptoService } from '../common/crypto.service';
import { LocalUserService } from '../common/local-user.service';
import { PrismaService } from '../common/prisma.service';
import { SESSION_CHECKS } from '../auto-apply/appliers/ats-common';
import { SupportedPlatform } from './dto/upsert-credential.dto';

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
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdpSession: CDPSession;
  frames: Subject<RemoteLoginFrame>;
  pollTimer: NodeJS.Timeout;
  consecutiveLoggedIn: number;
  closed: boolean;
}

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

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--lang=fr-FR',
      ],
    });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
    });
    const page = await context.newPage();
    const cdpSession = await context.newCDPSession(page);

    const session: ActiveSession = {
      platform,
      browser,
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

    session.pollTimer = setInterval(() => this.pollLoginState(sessionId).catch(() => {}), 2000);

    return sessionId;
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
          break;
        }
      }
    } catch (error: any) {
      this.logger.warn(`Remote-login input relay failed: ${error.message}`);
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
      const emailEncrypted = this.crypto.encrypt('(connecté via navigateur intégré)');
      const sessionStateEncrypted = this.crypto.encrypt(JSON.stringify(storageState));

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
    await session.browser.close().catch(() => {});
  }

  async onModuleDestroy() {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.cleanup(sessionId, { dataUrl: null, status: 'error', message: 'Serveur redémarré.' });
    }
  }
}
