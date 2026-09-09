import type { Locator, Page } from 'playwright';

export function splitName(fullName: string): { first: string; last: string } {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export async function fillIfVisible(locator: Locator, value?: string | null): Promise<void> {
  if (!value) return;
  if (await locator.isVisible().catch(() => false)) {
    await locator.fill(value).catch(() => {});
  }
}

// Cookie-consent banners are near-universal on EU sites and sit on top of
// the page, intercepting clicks on whatever's underneath (confirmed live on
// France Travail: a `pe-cookies` overlay blocked the "Postuler" button).
// Accepting one is exactly what a human visitor has to do too — not an
// anti-bot workaround, just clearing an actual UI element. Called once,
// right after navigation, before any other interaction.
export async function dismissCookieBanner(page: Page): Promise<void> {
  const acceptButton = page
    .getByRole('button', {
      name: /tout accepter|accepter tout|accepter les cookies|^accepter$|j'accepte|accept all|accept cookies|^accept$|i agree/i,
    })
    .first();

  if (await acceptButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await acceptButton.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

// Confirmed live on HelloWork: a failed bot-detection check (FriendlyCaptcha)
// shows up as inline text on the *same* URL ("Échec de la vérification —
// Browser check failed, try a different browser"), not a URL change — a
// URL-only check misses it entirely. Checked after every login attempt,
// across every account-based applier; on a hit, the applier must abandon
// and report `needs_review`, never try to work around it.
const SECURITY_CHECK_TEXT = /échec de la vérification|browser check failed|verify you are human|unusual activity|friendlycaptcha|hcaptcha|recaptcha|security check|vérification supplémentaire|prouvez que vous êtes humain/i;

export async function hasSecurityCheck(page: Page): Promise<boolean> {
  if (SECURITY_CHECK_TEXT.test(page.url())) return true;
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  return SECURITY_CHECK_TEXT.test(bodyText);
}
