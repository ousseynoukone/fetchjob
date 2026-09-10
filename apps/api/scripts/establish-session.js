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

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const { PrismaClient } = require('@prisma/client');
const { createCipheriv, randomBytes } = require('crypto');
const readline = require('readline');

const LOGIN_URLS = {
  linkedin: 'https://www.linkedin.com/login',
  indeed: 'https://secure.indeed.com/account/login',
  hellowork: 'https://www.hellowork.com/fr-fr/candidat/connexion-inscription.html#connexion',
  france_travail: 'https://candidat.francetravail.fr/espacepersonnel/',
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

  console.log('\n👉 Connectez-vous simplement à votre compte LinkedIn dans la fenêtre qui vient de s\'ouvrir.');
  console.log('Dès que vous serez connecté (arrivée sur le fil d\'actualité), la session sera détectée et enregistrée automatiquement !\n');

  let autoDetected = false;
  // Auto-detect login by checking cookies and URL every second for up to 5 minutes
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const cookies = await context.cookies();
      const liAt = cookies.find((c) => c.name === 'li_at');
      const url = page.url();
      if (liAt && liAt.value && liAt.value !== 'delete me' && !url.includes('/login') && !url.includes('/checkpoint')) {
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
