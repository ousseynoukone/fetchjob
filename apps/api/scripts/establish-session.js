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

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.production.local') });

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set — expected it in apps/api/.env.production.local (production database + ' +
      'CREDENTIALS_ENCRYPTION_KEY, matching Render\'s env vars). Create that file first.',
  );
  process.exit(1);
}
console.log(`Target database: ${new URL(process.env.DATABASE_URL).hostname}\n`);

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

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(LOGIN_URLS[platform]);

  await prompt('\nOnce you are fully logged in, come back here and press Enter to save the session...\n');

  const storageState = await context.storageState();
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
