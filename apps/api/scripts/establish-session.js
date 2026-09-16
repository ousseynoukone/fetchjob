#!/usr/bin/env node
// Run this ON YOUR OWN MACHINE (never on the server) to establish a
// reusable login session for a job platform, by logging in yourself in a
// real, visible browser window — solving any CAPTCHA/2FA/Google login the
// way any human would. The captured session is then reused by every
// headless auto-apply run instead of the bot trying (and likely failing,
// or getting flagged) to automate the login form itself.
//
// Usage (from apps/api):
//   npm run establish-session -- linkedin you@example.com
//   npm run establish-session -- indeed you@example.com
//   npm run establish-session -- hellowork you@example.com
//   npm run establish-session -- france_travail you@example.com
//
// Reads CREDENTIALS_ENCRYPTION_KEY and DATABASE_URL from .env.production.local
// — deliberately NOT .env.local, which points at the dev-auto-apply branch.
// A session saved there would be invisible to the deployed Render app,
// which is the only thing that ever actually reuses it. Only `email` is
// stored (as a display label) — there is no password field on
// PlatformCredential anymore; login itself always happens in the real
// browser window below.

const fs = require('fs');
const path = require('path');

const envCandidates = [
  path.join(__dirname, '..', '.env.production.local'),
  path.join(process.cwd(), 'apps', 'api', '.env.production.local'),
  path.join(process.cwd(), '.env.production.local'),
];
for (const cand of envCandidates) {
  if (fs.existsSync(cand)) {
    require('dotenv').config({ path: cand });
    break;
  }
}

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set — expected it in apps/api/.env.production.local (production database + ' +
      'CREDENTIALS_ENCRYPTION_KEY, matching Render\'s env vars). Create that file first.',
  );
  process.exit(1);
}
console.log(`Target database: ${new URL(process.env.DATABASE_URL).hostname}\n`);

// No stealth plugin here on purpose — this script opens a real, visible
// browser for a human to log in by hand, so there's nothing to evade in the
// first place. Confirmed live: applying it anyway broke HelloWork's own
// FriendlyCaptcha widget outright ("Échec de la vérification — Problème de
// connexion avec https://eu-api.friendlycaptcha.eu/api/v1/puzzle"), almost
// certainly because the plugin's low-level overrides (WebGL renderer,
// canvas fingerprint, navigator properties, etc.) broke the JS the puzzle
// widget itself depends on to run — a genuine human clicking in a plain,
// unmodified Chromium window never needed the evasion at all.
const { chromium } = require('playwright');
const { PrismaClient } = require('@prisma/client');
const { createCipheriv, randomBytes } = require('crypto');
const readline = require('readline');

const LOGIN_URLS = {
  linkedin: 'https://www.linkedin.com/login',
  indeed: 'https://secure.indeed.com/account/login',
  hellowork: 'https://www.hellowork.com/fr-fr/candidat/connexion-inscription.html#connexion',
  france_travail: 'https://candidat.francetravail.fr/espacepersonnel/',
};

// Mirrors ats-common.ts's SESSION_CHECKS (duplicated rather than imported —
// this plain script runs outside the TS build, same reasoning as LOGIN_URLS
// above being duplicated instead of shared).
//
// Each check must return true while login is NOT yet complete. Absence of
// the platform's own login FORM is not, on its own, proof of a completed
// login: confirmed live on France Travail, whose flow has a 2FA step
// between the identifiant/password page and the real dashboard -- that 2FA
// page also doesn't have `#identifiant` on it, so a bare "form is gone"
// check fires as soon as the user reaches 2FA, well before they actually
// confirm it, saving a not-yet-authenticated session. France Travail's
// check therefore also requires a positive sighting of "Mon espace
// personnel" (confirmed live: this heading renders reliably even while the
// dashboard's own widgets are still stuck on loading-skeleton placeholders,
// so it's a safe thing to wait for -- unlike the widgets themselves).
const LOGIN_WALL_CHECKS = {
  linkedin: async (page) => {
    const url = page.url();
    if (url.includes('/login') || url.includes('/uas/login') || url.includes('/checkpoint')) return true;
    return page.locator('#username').first().isVisible().catch(() => false);
  },
  indeed: async (page) =>
    page.locator('#login-email-input, input[name="__email"]').first().isVisible().catch(() => false),
  hellowork: async (page) => page.locator('input[name="email2"]').first().isVisible().catch(() => false),
  france_travail: async (page) => {
    const onIdentifiantStep = await page
      .locator('#identifiant, input[name="identifiant"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (onIdentifiantStep) return true;
    const onDashboard = await page.getByText(/mon espace personnel/i).first().isVisible().catch(() => false);
    return !onDashboard;
  },
};

const LOGIN_INSTRUCTIONS = {
  linkedin: 'à votre compte LinkedIn',
  indeed: 'à votre compte Indeed',
  hellowork: 'à votre compte HelloWork',
  france_travail: 'à votre espace personnel France Travail',
};

function encrypt(plainText, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  const [, , platform, email] = process.argv;

  if (!platform || !LOGIN_URLS[platform] || !email) {
    console.error(`Usage: node establish-session.js <${Object.keys(LOGIN_URLS).join('|')}> <email>`);
    process.exit(1);
  }

  const keyRaw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!keyRaw) {
    console.error('CREDENTIALS_ENCRYPTION_KEY is not set in the environment.');
    process.exit(1);
  }
  const key = Buffer.from(keyRaw, 'base64');

  console.log(`Opening a real browser window for "${platform}". Log in yourself — including any`);
  console.log('Google sign-in, 2FA, or CAPTCHA. This script never touches that part.');

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--lang=fr-FR',
    ],
  });
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 800 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    extraHTTPHeaders: {
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      DNT: '1',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  const page = await context.newPage();
  await page.goto(LOGIN_URLS[platform]);

  console.log(`\n👉 Connectez-vous simplement ${LOGIN_INSTRUCTIONS[platform]} dans la fenêtre qui vient de s'ouvrir.`);
  console.log('Dès que la connexion sera détectée, la session sera enregistrée automatiquement !\n');

  let autoDetected = false;
  // Auto-detect login by checking the platform's own login-wall selector
  // every second for up to 5 minutes. Skips the first 3 checks (~3s) so a
  // still-loading login page (selector not rendered yet) can't be
  // mistaken for "already logged in".
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (i < 3) continue;
    try {
      const onLoginWall = await LOGIN_WALL_CHECKS[platform](page);
      if (!onLoginWall) {
        console.log('✅ Connexion détectée automatiquement !');
        autoDetected = true;
        // Wait 2s to allow all session cookies to settle
        await new Promise((r) => setTimeout(r, 2000));
        break;
      }
    } catch {
      // If browser was closed or page navigating, ignore and continue
    }
  }

  if (!autoDetected) {
    await prompt('\nSi vous êtes connecté, appuyez sur Entrée pour sauvegarder la session...\n');
  }

  const storageState = await context.storageState();
  if (platform === 'linkedin' && Array.isArray(storageState.cookies)) {
    const hasLiAt = storageState.cookies.some((c) => c.name === 'li_at');
    if (!hasLiAt) {
      console.warn('\n⚠️ ATTENTION : Le cookie de session "li_at" n\'a pas été détecté !');
      console.warn('Êtes-vous bien connecté sur LinkedIn dans la fenêtre ouverte ?');
    } else {
      console.log('✅ Cookie li_at détecté avec succès !');
    }
    storageState.cookies = storageState.cookies.map((c) => {
      if (c.domain && c.domain.includes('linkedin.com')) {
        return { ...c, domain: '.linkedin.com' };
      }
      return c;
    });
  }
  await browser.close();

  const prisma = new PrismaClient();
  try {
    let user = await prisma.user.findFirst({ where: { email: 'me@local' } });
    if (!user) user = await prisma.user.create({ data: { email: 'me@local', name: 'Me' } });

    await prisma.platformCredential.upsert({
      where: { userId_platform: { userId: user.id, platform } },
      update: {
        emailEncrypted: encrypt(email, key),
        sessionStateEncrypted: encrypt(JSON.stringify(storageState), key),
        lastLoginAt: new Date(),
        lastLoginError: null,
      },
      create: {
        userId: user.id,
        platform,
        emailEncrypted: encrypt(email, key),
        sessionStateEncrypted: encrypt(JSON.stringify(storageState), key),
        lastLoginAt: new Date(),
      },
    });

    console.log(`\nSession saved for "${platform}". The next auto-apply run will reuse it instead of trying to log in.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
