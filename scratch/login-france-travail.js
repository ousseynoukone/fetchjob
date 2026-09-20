const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { ImapFlow } = require('imapflow');

const prisma = new PrismaClient();
const rawKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
if (!rawKey) {
  console.error('CREDENTIALS_ENCRYPTION_KEY missing');
  process.exit(1);
}
const key = Buffer.from(rawKey, 'base64');

function decrypt(payload) {
  if (!payload) return null;
  const [ivB64, authTagB64, ciphertextB64] = payload.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]).toString('utf8');
}

function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;
}

async function dismissShadowCookieBanner(page) {
  await page.evaluate(() => {
    const peCookies = document.querySelector('pe-cookies');
    if (peCookies && peCookies.shadowRoot) {
      const acceptBtn = peCookies.shadowRoot.querySelector('#pecookies-accept-all, #pecookies-continue-btn');
      if (acceptBtn) acceptBtn.click();
    }
  }).catch(() => {});
}

async function pollGmailForOtp(user, pass, since, maxWaitMs = 60000) {
  console.log(`Polling Gmail (${user}) via IMAP for France Travail code received after ${since.toISOString()}...`);
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: user.trim(),
        pass: pass.trim().replace(/\s+/g, ''),
      },
      logger: false,
    });
    client.on('error', () => {});

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const messages = await client.search({
          or: [
            { from: 'francetravail.fr' },
            { from: 'pole-emploi.fr' },
          ],
          since,
        });

        if (messages && messages.length > 0) {
          // Check from newest to oldest
          for (let i = messages.length - 1; i >= 0; i--) {
            const seq = messages[i];
            const msg = await client.fetchOne(seq, { envelope: true, source: true });
            const msgDate = new Date(msg.envelope?.date || 0);
            if (msgDate >= since) {
              const text = msg.source.toString('utf8');
              const clean = text
                .replace(/<[^>]+>/g, ' ')
                .replace(/=\r?\n/g, '')
                .replace(/=C3=A0/gi, 'à')
                .replace(/=C3=A9/gi, 'é')
                .replace(/=C3=A8/gi, 'è')
                .replace(/=20/g, ' ')
                .replace(/&nbsp;/gi, ' ');

              const pat = /(?:code\s*(?:(?:à|a)\s*usage\s*unique)?\s*(?:de\s*)?(?:validation|confirmation|connexion|sécurité|securite|vérification|verification|accès|acces)?\s*(?:est(?:\s*le)?|is)?\s*[:\s]*)([0-9]{6,8})\b/i;
              const match = clean.match(pat);
              if (match && match[1]) {
                console.log(`[IMAP] Found code: ${match[1]} (Subject: ${msg.envelope?.subject}, Date: ${msgDate.toISOString()})`);
                await client.logout().catch(() => {});
                return match[1];
              }

              const matches = clean.match(/\b[0-9]{8}\b/g);
              if (matches) {
                for (const m of matches) {
                  if (!m.startsWith('202') && !m.startsWith('19') && !m.startsWith('10512')) {
                    console.log(`[IMAP] Found code (fallback): ${m} (Subject: ${msg.envelope?.subject}, Date: ${msgDate.toISOString()})`);
                    await client.logout().catch(() => {});
                    return m;
                  }
                }
              }
            }
          }
        }
      } finally {
        lock.release();
      }
      await client.logout().catch(() => {});
    } catch (err) {
      console.warn(`[IMAP] Polling attempt error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

async function main() {
  console.log('=== Connecting France Travail with automated Gmail OTP resolution ===');

  // 1. Retrieve credentials
  const ftCred = await prisma.platformCredential.findFirst({ where: { platform: 'france_travail' } });
  if (!ftCred) {
    console.error('No France Travail credentials found in DB');
    process.exit(1);
  }

  const ftId = decrypt(ftCred.emailEncrypted);
  let ftPass = null;
  if (ftCred.sessionStateEncrypted) {
    try {
      const sess = JSON.parse(decrypt(ftCred.sessionStateEncrypted));
      ftPass = sess.password;
    } catch {}
  }

  if (!ftId || !ftPass) {
    console.error('France Travail identifier or password not found');
    process.exit(1);
  }

  // Retrieve Gmail credentials
  const gmailCred = await prisma.platformCredential.findFirst({ where: { platform: 'gmail' } });
  const gmailEmail = gmailCred?.emailEncrypted ? decrypt(gmailCred.emailEncrypted) : null;
  let gmailPass = null;
  if (gmailCred?.sessionStateEncrypted) {
    try {
      const gSess = JSON.parse(decrypt(gmailCred.sessionStateEncrypted));
      gmailPass = gSess.password || gSess.storageState;
    } catch (e) {
      const raw = decrypt(gmailCred.sessionStateEncrypted);
      if (!raw.startsWith('{')) gmailPass = raw;
    }
  }

  if (!gmailEmail || !gmailPass) {
    console.error('Gmail credentials / App Password not configured');
    process.exit(1);
  }

  console.log(`FT User: ${ftId} | Gmail: ${gmailEmail}`);

  // 2. Launch browser
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'fr-FR',
    extraHTTPHeaders: {
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  const page = await context.newPage();

  try {
    console.log('Navigating to France Travail espace personnel...');
    await page.goto('https://candidat.francetravail.fr/espacepersonnel/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    await dismissShadowCookieBanner(page);

    console.log('Waiting for #identifiant...');
    const idField = page.locator('#identifiant, input[name="identifiant"]').first();
    await idField.waitFor({ state: 'visible', timeout: 15000 });
    await dismissShadowCookieBanner(page);

    console.log('Filling identifiant and password...');
    await idField.fill(ftId);
    await page.waitForTimeout(300);

    const passField = page.locator('#password, input[name="password"], input[type="password"]').first();
    await passField.waitFor({ state: 'visible', timeout: 5000 });
    await passField.fill(ftPass);
    await page.waitForTimeout(500);

    const startTime = new Date(Date.now() - 15000); // 15s window
    console.log('Clicking submit...');
    const submitBtn = page.locator('#submit, #boutonConnexion, #boutonSeConnecter, button:has-text("Se connecter"), button[type="submit"]').first();
    await submitBtn.click({ force: true });

    console.log('Waiting for navigation / 2FA screen...');
    await page.waitForTimeout(4000);
    console.log('Current URL after submit:', page.url());

    // Check if 2FA channel selection is shown
    const emailOption = page.locator('#canal-1, a:has-text("Recevoir un code par e-mail"), label:has-text("Recevoir un code par e-mail")').first();
    if (await emailOption.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log('Found 2FA email channel option! Selecting it...');
      await emailOption.click();
      await page.waitForTimeout(3000);
    }

    // Check for segmented code inputs (#code-1 to #code-8)
    const code1 = page.locator('#code-1').first();
    const hasCode1 = await code1.isVisible({ timeout: 6000 }).catch(() => false);

    if (hasCode1) {
      console.log('8-digit segmented OTP inputs detected on page.');
      const code = await pollGmailForOtp(gmailEmail, gmailPass, startTime, 60000);
      if (!code) {
        throw new Error('Timeout waiting for France Travail OTP code in Gmail inbox');
      }

      console.log(`Entering 8-digit OTP code [${code}] into fields #code-1..#code-8...`);
      for (let i = 0; i < 8 && i < code.length; i++) {
        const input = page.locator(`#code-${i + 1}`).first();
        if (await input.isVisible().catch(() => false)) {
          await input.fill(code[i]);
          await page.waitForTimeout(80);
        }
      }

      console.log('Submitting OTP verification...');
      const otpSubmitBtn = page.locator('#submit, button[type="submit"]').first();
      await otpSubmitBtn.click();
      await page.waitForTimeout(4000);

      // Check if "Faire confiance à ce navigateur" consent screen is shown
      const trustBtn = page.locator('button:has-text("Faire confiance à ce navigateur"), a:has-text("Faire confiance à ce navigateur"), button:has-text("confiance")').first();
      if (await trustBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
        console.log('Found "Faire confiance à ce navigateur" button! Clicking to remember session for 3 months...');
        await trustBtn.click();
        await page.waitForTimeout(5000);
      }
    } else {
      console.log('No 2FA prompted or already passed.');
    }

    console.log('Checking if authenticated...');
    let currentUrl = page.url();
    console.log('URL after OTP flow:', currentUrl);

    // If still on XUI but "Faire confiance" or success message is visible, click it or navigate to espace personnel
    const trustBtnAfter = page.locator('button:has-text("Faire confiance à ce navigateur"), a:has-text("Faire confiance à ce navigateur")').first();
    if (await trustBtnAfter.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('Clicking "Faire confiance à ce navigateur"...');
      await trustBtnAfter.click();
      await page.waitForTimeout(5000);
    }

    // Navigate to espace personnel to verify and get final session cookies
    if (!page.url().includes('candidat.francetravail.fr/espacepersonnel/')) {
      console.log('Navigating to espacepersonnel to verify session...');
      await page.goto('https://candidat.francetravail.fr/espacepersonnel/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    currentUrl = page.url();
    console.log('Final URL:', currentUrl);

    const isLoginWall = currentUrl.includes('authentification') || (await page.locator('#identifiant').isVisible().catch(() => false));
    if (isLoginWall) {
      const errorText = await page.evaluate(() => {
        const err = document.querySelector('.error, .alert, .text-danger, #id-error-message, .notification--error');
        return err ? err.innerText.trim() : null;
      });
      throw new Error(`Login wall still visible! Error message: ${errorText || 'none'}`);
    }

    console.log('SUCCESS! Logged into France Travail espace personnel.');

    // Save the new session state
    const storageState = await context.storageState();
    const updatedPayload = JSON.stringify({
      password: ftPass,
      storageState: JSON.stringify(storageState),
    });

    await prisma.platformCredential.update({
      where: { id: ftCred.id },
      data: {
        sessionStateEncrypted: encrypt(updatedPayload),
        lastLoginAt: new Date(),
        lastLoginError: null,
      },
    });

    console.log('Successfully updated France Travail session in database!');
  } catch (err) {
    console.error('Login process failed:', err.message);
    await page.screenshot({ path: '/tmp/ft-login-error.png' }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(() => process.exit(1));
