import type { BrowserContext, Locator, Page } from 'playwright';
import { readFile } from 'fs/promises';

// The functions passed to page.evaluate() below run inside the browser, not
// in Node — this project's tsconfig has no DOM lib, so `document` is
// declared locally rather than pulling DOM types into the whole backend.
declare const document: any;

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

// LinkedIn's own locale subdomains (fr.linkedin.com, de.linkedin.com, ...)
// throw ERR_TOO_MANY_REDIRECTS with a stored session cookie — confirmed
// live both in the auto-apply flow and, separately, in VerificationService
// revisiting a stored sourceUrl directly (the same bug, just two different
// call sites that had each grown their own navigation code instead of
// sharing this). Normalizing to www. before any navigation avoids it
// entirely; harmless no-op on a URL that's already on another host.
export function normalizeLinkedInUrl(url: string): string {
  return url.replace(/https?:\/\/[a-z]{2}\.linkedin\.com/i, 'https://www.linkedin.com');
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

// Every applier here uploads the CV from a temp file on disk (see
// auto-apply.service.ts). Playwright's setInputFiles(path) uses that path's
// own basename as the uploaded filename — confirmed live, a recruiter would
// see literally "findurjob-auto-apply-cm...pdf" attached to the
// candidature. Reading the file once and re-uploading it as a buffer lets
// the uploaded filename be the candidate's own name instead (see
// ApplyContext.cvFileName), independent of whatever the temp file on disk
// happens to be called.
export async function uploadCv(fileInput: Locator, ctx: { cvPdfPath: string; cvFileName: string }): Promise<void> {
  const buffer = await readFile(ctx.cvPdfPath);
  await fileInput.setInputFiles({ name: ctx.cvFileName, mimeType: 'application/pdf', buffer });
}

const IDENTITY_PATTERNS = {
  first: /first ?name|pr[ée]nom/i,
  last: /last ?name|^nom\b|nom de famille/i,
  full: /full ?name|^name$|nom complet|nom et pr[ée]nom/i,
  email: /e-?mail|courriel/i,
  phone: /phone|t[ée]l[ée]phone|mobile|portable/i,
} as const;

type IdentityRole = keyof typeof IDENTITY_PATTERNS;

// Runs inside the browser (via page.evaluate): finds every empty, visible
// text-like field, resolves its real label the same robust way the AI
// snapshot does (id/for, wrapping <label>, aria-label, fieldset/legend,
// previous-sibling text — NOT just a plain getByLabel, which misses custom
// form widgets that skip a formal <label> association entirely), and
// classifies it by matching label+placeholder+input-type against bilingual
// patterns. Tags each match with a temporary attribute so Node-side code
// can address the exact element without needing to reconstruct a selector.
async function scanIdentityFields(page: Page): Promise<{ role: IdentityRole; idx: number }[]> {
  return page.evaluate((patterns: Record<IdentityRole, { source: string; flags: string }>) => {
    const doc: any = document;
    const compiled = Object.fromEntries(
      Object.entries(patterns).map(([role, p]) => [role, new RegExp(p.source, p.flags)]),
    ) as Record<IdentityRole, RegExp>;

    const isVisible = (el: any) => !!(el.offsetParent || (el.getClientRects && el.getClientRects().length));

    const extractLabel = (el: any): string => {
      const id = el.getAttribute('id');
      if (id) {
        const escape = (globalThis as any).CSS?.escape;
        const lbl = doc.querySelector(`label[for="${escape ? escape(id) : id}"]`);
        if (lbl?.textContent?.trim()) return lbl.textContent.trim();
      }
      const wrappingLabel = el.closest('label');
      if (wrappingLabel?.textContent?.trim()) return wrappingLabel.textContent.trim();
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel?.trim()) return ariaLabel.trim();
      const fieldset = el.closest('fieldset');
      const legend = fieldset?.querySelector('legend');
      if (legend?.textContent?.trim()) return legend.textContent.trim();
      let prev = el.previousElementSibling;
      while (prev) {
        const text = prev.textContent?.trim();
        if (text) return text;
        prev = prev.previousElementSibling;
      }
      return '';
    };

    const matches: { role: IdentityRole; idx: number }[] = [];
    // Seeded from any tags already on the page (not reset to 1 each call) —
    // a stale tag left on an element from a previous, now-filled pass would
    // otherwise collide with a fresh idx assigned on this pass, and
    // `[data-identity-idx="1"]` would then match two different elements.
    const existingIdxs = Array.from(doc.querySelectorAll('[data-identity-idx]')).map(
      (e: any) => Number(e.getAttribute('data-identity-idx')) || 0,
    );
    let idx = existingIdxs.length ? Math.max(...existingIdxs) + 1 : 1;
    const candidates = Array.from(
      doc.querySelectorAll(
        'input:not([type=file]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=password]):not([type=radio]):not([type=checkbox]), textarea',
      ),
    ) as any[];

    for (const el of candidates) {
      if (!isVisible(el) || el.disabled) continue;
      const value = (el.value || '').trim();
      if (value) continue; // already filled — don't overwrite

      const type = (el.type || '').toLowerCase();
      const label = extractLabel(el);
      const placeholder = el.getAttribute('placeholder') || '';
      const haystack = `${label} ${placeholder}`;

      let role: IdentityRole | null = null;
      if (type === 'email' || compiled.email.test(haystack)) role = 'email';
      else if (type === 'tel' || compiled.phone.test(haystack)) role = 'phone';
      else if (compiled.first.test(haystack)) role = 'first';
      else if (compiled.last.test(haystack)) role = 'last';
      else if (compiled.full.test(haystack)) role = 'full';
      if (!role) continue;

      const tagIdx = idx++;
      el.setAttribute('data-identity-idx', String(tagIdx));
      matches.push({ role, idx: tagIdx });
    }

    return matches;
  }, Object.fromEntries(Object.entries(IDENTITY_PATTERNS).map(([role, re]) => [role, { source: re.source, flags: re.flags }])) as any);
}

// Fills first/last (or full) name, email and phone on whatever application
// form is currently visible — in both French and English phrasing.
//
// Confirmed live: HelloWork's, Indeed's and France Travail's own appliers
// never filled these at all, on the (wrong) assumption that the platform's
// own logged-in session would pre-fill them on the application form itself.
// It doesn't — the form renders with genuinely blank Nom/Prénom/Email
// inputs, which then fail validation on every single attempt with no way
// for the user to "answer" a question that isn't really a custom question
// at all (these labels are deliberately excluded from both the learned-
// answers system and the AI fallback — see KNOWN_FIELD_LABEL_EXCLUDE in
// form-fields.ts — precisely because they're supposed to be handled here,
// not treated as a screening question). Shared by every applier instead of
// each hand-rolling its own narrower, English-only version.
export async function fillIdentityFields(
  page: Page,
  cv: { fullName: string; email: string; phone: string },
): Promise<void> {
  const { first, last } = splitName(cv.fullName);
  const values: Record<IdentityRole, string | undefined> = {
    first,
    last,
    full: cv.fullName,
    email: cv.email,
    phone: cv.phone,
  };

  // Always two passes, not "stop at the first success" — some SPA forms
  // mount their identity fields a tick apart from one another (confirmed
  // live: HelloWork filled "Prénom" immediately on pass one, but "Nom" and
  // "Email" were still unfilled at that exact moment and only became
  // fillable a moment later). Stopping as soon as *any* field got filled —
  // the previous version of this loop — meant a single early success masked
  // every other field that genuinely needed the second pass.
  for (let attempt = 0; attempt < 2; attempt++) {
    const matches = await scanIdentityFields(page).catch(() => []);
    for (const m of matches) {
      const value = values[m.role];
      if (!value) continue;
      await page
        .locator(`[data-identity-idx="${m.idx}"]`)
        .first()
        .fill(value)
        .catch(() => {});
    }
    if (attempt === 0) await page.waitForTimeout(700);
    await page.waitForTimeout(700);
  }
}

// Cookie-consent banners are near-universal on EU sites and sit on top of
// the page, intercepting clicks on whatever's underneath (confirmed live on
// France Travail: a `pe-cookies` overlay blocked the "Postuler" button).
// Accepting one is exactly what a human visitor has to do too — not an
// anti-bot workaround, just clearing an actual UI element. Called once,
// right after navigation, before any other interaction.
// Confirmed live via a Cegedim career-site apply-time screenshot: its
// consent modal's button reads "Accepter & Fermer" — not matched by any
// earlier alternative here (closest was `^accepter$`, an exact-text match),
// so the modal sat there un-dismissed through the whole rest of the attempt.
const COOKIE_ACCEPT_TEXT =
  /tout accepter|accepter tout|accepter les cookies|^accepter$|accepter (&|et) fermer|j'accepte|accept all|accept cookies|^accept$|i agree/i;

export async function dismissCookieBanner(page: Page): Promise<void> {
  const acceptButton = page.getByRole('button', { name: COOKIE_ACCEPT_TEXT }).first();

  if (await acceptButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await acceptButton.click().catch(() => {});
    // Confirmed live on a Cegedim career-site retry: this button triggers a
    // real page reload rather than just fading out an overlay in place — a
    // plain fixed wait raced it, and the very next page.evaluate() call
    // (generic.applier.ts's second dismiss attempt, right before the AI
    // form loop) crashed the whole attempt with "Execution context was
    // destroyed, most likely because of a navigation". Waiting for
    // domcontentloaded too covers that case; it's a same-tick no-op on the
    // far more common case (a banner that fades out with no navigation at
    // all), so this doesn't slow down every other site's happy path.
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
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
// Confirmed live via the campaign's own live-view screenshot: a stored
// LinkedIn session that isn't actually authenticated doesn't redirect to
// /login at all when landing on a job posting page — it stays on the same
// URL and shows this "sign in to see who you know" overlay instead (the
// header still shows "S'identifier"/"S'inscrire", confirming logged-out).
// The old URL/#username-only check missed this entirely, so the applier
// just stalled trying to click a Postuler button the modal was covering.
const LINKEDIN_LOGGED_OUT_TEXT = /identifiez[- ]vous pour voir qui vous connaissez|sign in to see who you already know/i;

export const SESSION_CHECKS: Record<string, SessionCheck> = {
  linkedin: {
    homeUrl: 'https://www.linkedin.com/feed/',
    isLoginWallVisible: async (page) => {
      if (page.url().includes('/login') || page.url().includes('/uas/login')) return true;
      if (await page.locator('#username').isVisible().catch(() => false)) return true;

      // If top nav or profile avatar is visible, user is authenticated
      const hasNav = await page.locator('.global-nav__me, #global-nav, .feed-identity-module, [data-control-name="nav.settings"]').first().isVisible().catch(() => false);
      if (hasNav) return false;

      const hasSignInHeader = await page.locator('a.nav__button-secondary, a:has-text("S\'identifier"), a:has-text("Sign in")').first().isVisible().catch(() => false);
      if (hasSignInHeader) return true;

      const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
      return LINKEDIN_LOGGED_OUT_TEXT.test(bodyText);
    },
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
    // The identifiant/password form only ever appears on the login page
    // itself -- on an ordinary page like a job listing, a logged-out visitor
    // instead sees a "Connexion" button in the header nav (confirmed live: an
    // applier that reported "étape inattendue" on a job listing whose own
    // screenshot showed "Connexion" in the nav, meaning the stored session
    // was never actually authenticated -- the identifiant-only check missed
    // this because that page never renders a login form at all).
    isLoginWallVisible: async (page) => {
      const onLoginForm = await page.locator('#identifiant, input[name="identifiant"]').first().isVisible().catch(() => false);
      if (onLoginForm) return true;
      return page
        .getByRole('button', { name: /^connexion/i })
        .or(page.getByRole('link', { name: /^connexion/i }))
        .first()
        .isVisible()
        .catch(() => false);
    },
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

// A posting whose apply button/link genuinely isn't present anymore (closed,
// expired, or the employer stopped accepting applications) is a distinct,
// resolvable outcome from "we failed to detect a button that's actually
// there" -- checked as a fallback right before an applier gives up and
// reports the generic "no apply button found", so the campaign log/UI can
// tell a stale posting apart from a real detection gap worth investigating.
const JOB_CLOSED_TEXT =
  /no longer accepting applications|n'accepte plus de candidatures|ne recrute plus|cette offre n'est plus disponible|this job (is no longer available|has expired)|offre expirée|candidatures closes/i;

export async function hasJobClosedIndicator(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return JOB_CLOSED_TEXT.test(bodyText);
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
  // 1. Direct href check (e.g. LinkedIn safety redirect href="/safety/go/?url=...")
  const href = await clickable.getAttribute('href').catch(() => null);
  if (href) {
    try {
      const parsed = new URL(href, page.url());
      const targetParam = parsed.searchParams.get('url');
      if (targetParam) {
        const decoded = decodeURIComponent(targetParam);
        if (!ownDomain.test(decoded)) return decoded;
      }
      if (!ownDomain.test(parsed.href) && !parsed.pathname.includes('/safety/go')) {
        return parsed.href;
      }
    } catch { /* ignore */ }
  }

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
