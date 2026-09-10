import type { BrowserContext, Locator, Page } from 'playwright';

// Scraping/resolution only ever needs the text (job cards, JSON-LD, an
// apply-button href) — company logos, hero photos and web fonts add real
// weight and bandwidth for zero value there. Scripts/stylesheets stay on:
// WTTJ's WAF challenge and general page hydration depend on them running.
// Not applied to BrowserSessionService's default context (real apply/form
// flows), only where a caller opts in explicitly.
export async function blockHeavyResources(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    return ['image', 'media', 'font'].includes(type) ? route.abort() : route.continue();
  });
}

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

export interface SessionCheck {
  // A page that requires being logged in, with no side effect from just
  // visiting it (never a candidature form) — safe to load on a schedule,
  // not just when an actual apply attempt happens to need it.
  homeUrl: string;
  isLoginWallVisible: (page: Page) => Promise<boolean>;
}

// One definition per platform, shared between each applier's own
// `ensureLoggedIn` (checked organically, right before it would try to use
// the session) and SessionHealthService's proactive daily check (visits
// `homeUrl` directly, so a dead/expiring session is caught and emailed
// about before a real campaign run ever stumbles into it). A single source
// of truth here means a selector fix only has to happen once. Every one of
// these URL+selector pairs was confirmed live (anonymous, logged-out
// request each correctly lands on the platform's real login page).
export const SESSION_CHECKS: Record<string, SessionCheck> = {
  linkedin: {
    homeUrl: 'https://www.linkedin.com/feed/',
    isLoginWallVisible: async (page) =>
      page.url().includes('/login') ||
      page.url().includes('/uas/login') ||
      (await page.locator('#username').isVisible().catch(() => false)),
  },
  indeed: {
    homeUrl: 'https://myjobs.indeed.com/',
    isLoginWallVisible: async (page) =>
      page.locator('#login-email-input, input[name="__email"]').first().isVisible().catch(() => false),
  },
  hellowork: {
    homeUrl: 'https://www.hellowork.com/fr-fr/candidat/mon-espace.html',
    // HelloWork's login page has BOTH a signup form (input[name="email"])
    // and a login form (input[name="email2"]) in the same DOM — confirmed
    // live, kept here since this is the same check the applier itself uses.
    isLoginWallVisible: async (page) =>
      page.locator('input[name="email2"]').first().isVisible().catch(() => false),
  },
  france_travail: {
    homeUrl: 'https://candidat.francetravail.fr/espacepersonnel/',
    isLoginWallVisible: async (page) =>
      page.locator('#identifiant, input[name="identifiant"]').first().isVisible().catch(() => false),
  },
};

// Used by the verification pass (see verification.service.ts) to confirm a
// candidature the apply flow already reported as sent actually got recorded
// by the platform — revisiting the offer's own page with its stored session
// and looking for whatever "you already applied" state it shows instead of
// an active apply button. NOT verified against a real logged-in session on
// any of these four platforms (none was available while building this) —
// best-effort patterns based on each platform's known/documented wording;
// expect to tighten these once a real run reports false negatives.
const ALREADY_APPLIED_TEXT =
  /vous avez (déjà )?postulé|candidature (envoyée|déjà envoyée|transmise)|vous avez postulé le|application submitted|you('| ha)ve applied|already applied|applied \d+ (day|week|month|hour)|postulé le \s*\d|application (sent|received)|applied on /i;

export async function hasAlreadyAppliedIndicator(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return ALREADY_APPLIED_TEXT.test(bodyText);
}

// LinkedIn/Indeed/HelloWork all have postings with no in-platform apply
// flow — their "Postuler"/"Apply" button just sends the visitor to the
// employer's own site instead. Confirmed live behavior varies even within
// one platform: sometimes a new tab (popup), sometimes the same page
// navigates away. Used by each of those three appliers instead of giving
// up the moment their own in-platform flow isn't available, so ATS-by-URL
// routing (or the generic fallback) gets a real shot at the real form.
// Returns null when the click didn't actually leave the platform's own
// domain — meaning this wasn't really an external-redirect case after all.
export async function resolveExternalApplyUrl(page: Page, clickable: Locator, ownDomain: RegExp): Promise<string | null> {
  const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await clickable.click().catch(() => {});
  const popup = await popupPromise;

  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    const url = popup.url();
    await popup.close().catch(() => {});
    return url && !ownDomain.test(url) ? url : null;
  }

  await page.waitForTimeout(1500);
  const url = page.url();
  return !ownDomain.test(url) ? url : null;
}

// Welcome to the Jungle hosts the job posting itself, but the real "Postuler"
// action almost always points out to whatever ATS the employer actually uses
// (Greenhouse, Lever, Workday, SmartRecruiters, or something else entirely) —
// confirmed live on a real posting: its apply button links to a Beetween
// form, nothing to do with WTTJ's own domain. That target only exists as a
// link's href on the rendered page, so it has to be visited once before the
// usual ATS-by-URL routing (see auto-apply.service.ts's detectAtsKey) can
// even see it.
//
// Returns null — meaning "nothing better than the job page itself" — in two
// cases, both confirmed live: no apply link at all (page didn't render in
// time), or the link stays on welcometothejungle.com (some postings route
// through a WTTJ account sign-in instead of an external ATS: the href is
// `/fr/authenticate/signin`, which is no more automatable than the job page
// itself). Only a genuine off-WTTJ redirect is worth returning.
export async function resolveWelcomeToTheJungleApplyUrl(page: Page, jobPageUrl: string): Promise<string | null> {
  await page.goto(jobPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await dismissCookieBanner(page);
  await page.waitForTimeout(2000); // same WAF-challenge/SPA-hydration delay as the scraper's enrichment step
  const href = await page.locator('a[data-role="job:apply"]').first().getAttribute('href').catch(() => null);
  if (!href) return null;

  try {
    const resolved = new URL(href, jobPageUrl);
    return resolved.hostname.endsWith('welcometothejungle.com') ? null : resolved.toString();
  } catch {
    return null;
  }
}
