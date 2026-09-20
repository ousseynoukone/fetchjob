import type { BrowserContext, Locator, Page } from 'playwright';
import { readFile } from 'fs/promises';
import type { GmailOtpService } from '../../common/gmail-otp.service';

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

async function jitter(minMs: number, maxMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
}

// Playwright's own .fill()/.click() are functionally reliable but
// behaviorally inert: .fill() sets the value directly (one `input` event,
// no real per-character keydown/keyup sequence or mouse movement first),
// and .click() jumps the pointer straight to the target's center with no
// travel at all. Sophisticated behavioral bot-detection (DataDome,
// PerimeterX, and some ATS platforms' own anti-automation layers --
// several of which this project's own sources already run into, see APEC/
// WTTJ's DataDome and Indeed's Cloudflare) profiles exactly this shape.
// humanFill/humanClick route the highest-traffic fill/click paths (every
// identity field, on every applier, plus the AI-driven form loop's own
// dynamic filler and its submit/next clicks) through an approximated mouse
// path and per-keystroke typing instead. Not applied to every single
// `.fill()`/`.click()` call site in every individual ATS applier -- these
// two choke points already cover the large majority of real interactions;
// a handful of special-cased fields (e.g. LinkedIn's own password auto-
// login field) still use a plain fill, a smaller, lower-frequency surface.
export async function humanFill(locator: Locator, value: string): Promise<void> {
  if (!value) return;
  try {
    await locator.hover({ timeout: 3000 });
    await locator.click({ timeout: 3000 });
    await locator.pressSequentially(value, { delay: 35 + Math.random() * 70 });
  } catch {
    await locator.fill(value).catch(() => {});
  }
}

// Throws if the final click itself fails (same contract as Playwright's own
// .click()) rather than swallowing it -- callers that want a raw-DOM-click
// fallback for a covered/hidden element can still chain their own .catch()
// the way they already do around a plain .click().
export async function humanClick(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    const targetX = box.x + box.width * (0.4 + Math.random() * 0.2);
    const targetY = box.y + box.height * (0.4 + Math.random() * 0.2);
    // Approach from a random offset in the upper-left quadrant — dead-centre
    // approaches are a trivial bot tell that DataDome/PerimeterX specifically
    // check for.
    await page.mouse.move(
      targetX - 40 - Math.random() * 60,
      targetY - 20 - Math.random() * 40,
    ).catch(() => {});
    await jitter(50, 120);
    const steps = 3 + Math.floor(Math.random() * 3);
    for (let i = 1; i <= steps; i++) {
      const t = i / (steps + 1);
      await page.mouse.move(
        targetX * t + (Math.random() * 20 - 10),
        targetY * t + (Math.random() * 20 - 10),
        { steps: 4 },
      ).catch(() => {});
      await jitter(25, 70);
    }
    await page.mouse.move(targetX, targetY, { steps: 5 + Math.floor(Math.random() * 5) }).catch(() => {});
    await jitter(60, 160);
  }
  await locator.click({ timeout: 5000 });
}

export async function fillIfVisible(locator: Locator, value?: string | null): Promise<void> {
  if (!value) return;
  if (await locator.isVisible().catch(() => false)) {
    await humanFill(locator, value);
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
  linkedinUrl: /linkedin/i,
  githubUrl: /github/i,
  websiteUrl: /site|portfolio|site web|website|homepage/i,
  civility: /civilit[ée]|title|salutation|genre|gender|titre de civilit[ée]/i,
  country: /pays|country/i,
  currency: /devise|currency|monnaie/i,
  rqth: /rqth|handicap|travailleur handicap[ée]|disability/i,
  workAuth: /autorisation de travail|droit de travailler|work authori[sz]ation|eligible to work|l[ée]galement autoris[ée]/i,
  availability: /disponibilit[ée]|availability|notice period|d[ée]lai de pr[ée]avis/i,
} as const;

type IdentityRole = keyof typeof IDENTITY_PATTERNS;

// Runs inside the browser (via page.evaluate): finds every empty, visible
// text-like or select field, resolves its real label the same robust way the AI
// snapshot does (id/for, wrapping <label>, aria-label, fieldset/legend,
// previous-sibling text — NOT just a plain getByLabel, which misses custom
// form widgets that skip a formal <label> association entirely), and
// classifies it by matching label+placeholder+input-type against bilingual
// patterns. Tags each match with a temporary attribute so Node-side code
// can address the exact element without needing to reconstruct a selector.
async function scanIdentityFields(page: Page): Promise<{ role: IdentityRole; idx: number; tag: string }[]> {
  return page.evaluate((patterns: Record<IdentityRole, { source: string; flags: string }>) => {
    const doc: any = document;
    const compiled = Object.fromEntries(
      Object.entries(patterns).map(([role, p]) => [role, new RegExp(p.source, p.flags)]),
    ) as Record<IdentityRole, RegExp>;

    const isVisible = (el: any) => {
      if (!el.offsetParent && !(el.getClientRects && el.getClientRects().length)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      let node = el.parentElement;
      let depth = 0;
      while (node && depth < 10) {
        const style = (globalThis as any).getComputedStyle(node);
        if ((style.overflow === 'hidden' || style.overflowY === 'hidden') && node.clientHeight === 0) {
          return false;
        }
        node = node.parentElement;
        depth++;
      }
      return true;
    };

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

    const matches: { role: IdentityRole; idx: number; tag: string }[] = [];
    const existingIdxs = Array.from(doc.querySelectorAll('[data-identity-idx]')).map(
      (e: any) => Number(e.getAttribute('data-identity-idx')) || 0,
    );
    let idx = existingIdxs.length ? Math.max(...existingIdxs) + 1 : 1;
    const candidates = Array.from(
      doc.querySelectorAll(
        'input:not([type=file]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=password]):not([type=radio]):not([type=checkbox]), textarea, select',
      ),
    ) as any[];

    for (const el of candidates) {
      if (!isVisible(el) || el.disabled) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') {
        const selIdx = el.selectedIndex;
        const selectedOpt = selIdx >= 0 ? el.options[selIdx] : null;
        const optVal = (selectedOpt?.value || '').trim();
        const optText = (selectedOpt?.text || '').trim();
        if (optVal && !/^(0|\?|-1)?$/.test(optVal) && !/choisir|select|s[ée]lectionnez|--/i.test(optText)) {
          continue; // already chosen
        }
      } else {
        const value = (el.value || '').trim();
        if (value) continue; // already filled — don't overwrite
      }

      const type = (el.type || '').toLowerCase();
      const label = extractLabel(el);
      const placeholder = el.getAttribute('placeholder') || '';
      const name = el.getAttribute('name') || '';
      const id = el.getAttribute('id') || '';
      const haystack = `${label} ${placeholder} ${name} ${id}`.trim();

      let role: IdentityRole | null = null;
      if (type === 'email' || compiled.email.test(haystack)) role = 'email';
      else if (type === 'tel' || compiled.phone.test(haystack)) role = 'phone';
      else if (compiled.linkedinUrl.test(haystack)) role = 'linkedinUrl';
      else if (compiled.githubUrl.test(haystack)) role = 'githubUrl';
      else if (compiled.websiteUrl.test(haystack)) role = 'websiteUrl';
      else if (compiled.civility.test(haystack)) role = 'civility';
      else if (compiled.country.test(haystack)) role = 'country';
      else if (compiled.currency.test(haystack)) role = 'currency';
      else if (compiled.rqth.test(haystack)) role = 'rqth';
      else if (compiled.workAuth.test(haystack)) role = 'workAuth';
      else if (compiled.availability.test(haystack)) role = 'availability';
      else if (compiled.first.test(haystack)) role = 'first';
      else if (compiled.last.test(haystack)) role = 'last';
      else if (compiled.full.test(haystack)) role = 'full';
      if (!role) continue;

      const tagIdx = idx++;
      el.setAttribute('data-identity-idx', String(tagIdx));
      matches.push({ role, idx: tagIdx, tag });
    }

    return matches;
  }, Object.fromEntries(Object.entries(IDENTITY_PATTERNS).map(([role, re]) => [role, { source: re.source, flags: re.flags }])) as any);
}

async function selectOptionRobustly(locator: Locator, role: IdentityRole, targetValue: string): Promise<void> {
  const direct = await locator.selectOption({ label: targetValue }).catch(() => null);
  if (direct && direct.length) return;
  const directVal = await locator.selectOption({ value: targetValue }).catch(() => null);
  if (directVal && directVal.length) return;

  await locator
    .evaluate(
      (el: any, { role, targetValue }: { role: string; targetValue: string }) => {
        if (!el || !el.options) return;
        const regexMap: Record<string, RegExp> = {
          civility: /^(m\.|monsieur|mr|homme|male)$/i,
          country: /^(france|fr|fra)$/i,
          currency: /^(eur|euro|€)$/i,
          rqth: /^(non|no|aucun|false|0)$/i,
          workAuth: /^(oui|yes|true|1|autoris[ée])$/i,
          availability: /^(imm[ée]diate|imm[ée]diat|d[èe]s que possible|immediate|now)$/i,
        };
        const re = regexMap[role] || new RegExp(targetValue, 'i');
        for (let i = 0; i < el.options.length; i++) {
          const opt = el.options[i];
          const text = (opt.textContent || '').trim();
          const val = (opt.value || '').trim();
          if (re.test(text) || re.test(val)) {
            el.selectedIndex = i;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
        }
      },
      { role, targetValue },
    )
    .catch(() => {});
}

// Fills first/last (or full) name, email, phone, links, and standard candidate
// defaults (civilité, pays, devise, rqth, droit de travail, disponibilité) on
// whatever application form is currently visible.
export async function fillIdentityFields(
  page: Page,
  cv: { fullName: string; email: string; phone: string; links?: { type: string; url: string }[] },
): Promise<void> {
  const { first, last } = splitName(cv.fullName);
  const linkedinUrl = cv.links?.find((l) => /linkedin/i.test(l.type) || /linkedin\.com/i.test(l.url))?.url;
  const githubUrl = cv.links?.find((l) => /github/i.test(l.type) || /github\.com/i.test(l.url))?.url;
  const websiteUrl = cv.links?.find((l) => /portfolio|site|website|perso/i.test(l.type))?.url || cv.links?.[0]?.url;
  const values: Record<IdentityRole, string | undefined> = {
    first,
    last,
    full: cv.fullName,
    email: cv.email,
    phone: cv.phone,
    linkedinUrl,
    githubUrl,
    websiteUrl,
    civility: 'Monsieur',
    country: 'France',
    currency: 'EUR',
    rqth: 'Non',
    workAuth: 'Oui',
    availability: 'Immédiate',
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const matches = await scanIdentityFields(page).catch(() => []);
    for (const m of matches) {
      const value = values[m.role];
      if (!value) continue;
      const locator = page.locator(`[data-identity-idx="${m.idx}"]`).first();
      if (m.tag === 'select') {
        await selectOptionRobustly(locator, m.role, value);
      } else {
        await humanFill(locator, value);
      }
    }

    // Auto-select Monsieur for any Civilité radio buttons if unselected
    await page
      .evaluate(() => {
        const doc: any = document;
        const radios = Array.from(doc.querySelectorAll('input[type="radio"]')) as any[];
        for (const r of radios) {
          if (r.checked) continue;
          const wrappingLabel = (r.closest('label')?.textContent || '').trim();
          const nextText = (r.nextElementSibling?.textContent || '').trim();
          const val = (r.value || '').trim();
          const text = `${wrappingLabel} ${nextText} ${val}`;
          if (/^monsieur$|^m\.$|^homme$/i.test(text.trim())) {
            r.click();
            r.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
      })
      .catch(() => {});

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
  // Confirmed live via a real production screenshot on France Travail: a
  // page can carry MORE THAN ONE consent widget in the DOM at once — a
  // hidden `<pe-cookies>` custom element (its own shadow-root "Tout
  // accepter" button, which Playwright's locators do reach into) alongside
  // a completely separate, currently-VISIBLE "Faites un choix pour vos
  // cookies" modal with its own "Tout accepter" button. `.first()` here
  // used to pick whichever matched first in DOM order — if that happened
  // to be the hidden one, isVisible() correctly returned false and this
  // function gave up without ever discovering the real, visible modal
  // elsewhere on the page, leaving it blocking everything for the rest of
  // the attempt. Checks every match instead of stopping at the first.
  // Check common CMP consent buttons (Didomi, OneTrust, Axeptio, France Travail)
  const explicitCmp = page
    .locator('#didomi-notice-agree-button, #onetrust-accept-btn-handler, #pe-cookies-accept, #pe-cookies-refuse, #axeptio_btn_acceptAll')
    .first();
  if (await explicitCmp.isVisible().catch(() => false)) {
    await explicitCmp.click().catch(() => {});
    await page.waitForTimeout(500);
    return;
  }

  const acceptButtons = await page.getByRole('button', { name: COOKIE_ACCEPT_TEXT }).all().catch(() => []);
  let acceptButton: typeof acceptButtons[number] | null = null;
  for (const candidate of acceptButtons) {
    if (await candidate.isVisible().catch(() => false)) {
      acceptButton = candidate;
      break;
    }
  }
  // A brand-new widget can still take a moment to render after
  // navigation — one bounded retry of the same "check every match" pass
  // instead of a single instant snapshot.
  if (!acceptButton) {
    await page.waitForTimeout(1500);
    for (const candidate of await page.getByRole('button', { name: COOKIE_ACCEPT_TEXT }).all().catch(() => [])) {
      if (await candidate.isVisible().catch(() => false)) {
        acceptButton = candidate;
        break;
      }
    }
  }

  if (acceptButton) {
    // Use the same human-like mouse movement every other interaction uses —
    // a bare .click() on the cookie accept button is a detectable bot signal
    // on sites that profile mouse trajectories (DataDome, PerimeterX).
    await humanClick(page, acceptButton).catch(() => acceptButton.click().catch(() => {}));
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

  // France Travail's own `<pe-cookies>` custom element was the ORIGINAL
  // reason this function exists at all (see the comment above), but it was
  // never actually fixed — confirmed live, real auto-apply attempts kept
  // crashing on "<pe-cookies> intercepts pointer events" after a 30s
  // locator.click() timeout, on every single France Travail offer.
  // Root-caused directly: page.getByRole/getByText/a plain CSS id selector
  // all fail to find its "Tout accepter" button at all (isVisible() false
  // even given 6s), while a raw page.evaluate() reading
  // el.shadowRoot.querySelector() finds and clicks it immediately, and the
  // element genuinely collapses to display:none afterward — so this isn't a
  // missed text pattern or a timing race, Playwright's locator engine
  // simply never reaches inside this specific shadow root. Reaches in
  // directly instead; a harmless no-op via optional chaining on every site
  // that doesn't have this exact custom element.
  await page
    .evaluate(() => {
      const doc: any = (globalThis as any).document;
      const host = doc.querySelector('pe-cookies');
      const btn = host?.shadowRoot?.querySelector('#pecookies-accept-all, #pecookies-continue-btn') as any;
      btn?.click();
    })
    .catch(() => {});
}

// Confirmed live on HelloWork: a failed bot-detection check (FriendlyCaptcha)
// shows up as inline text on the *same* URL ("Échec de la vérification —
// Browser check failed, try a different browser"), not a URL change — a
// URL-only check misses it entirely. Checked after every login attempt,
// across every account-based applier; on a hit, the applier must abandon
// and report `needs_review`, never try to work around it.
const SECURITY_CHECK_TEXT = /échec de la vérification|browser check failed|verify you are human|unusual activity|friendlycaptcha|hcaptcha|recaptcha|datadome|cloudflare|security check|vérification supplémentaire|prouvez que vous êtes humain|validate you are human|vérification de sécurité en cours|vérifiez que vous êtes humain/i;

export async function hasSecurityCheck(page: Page): Promise<boolean> {
  if (SECURITY_CHECK_TEXT.test(page.url())) return true;
  for (const frame of page.frames()) {
    if (/captcha|datadome/i.test(frame.url())) return true;
  }
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
const LINKEDIN_LOGGED_OUT_TEXT =
  /identifiez[- ]vous pour voir qui vous connaissez|sign in to see who you already know|identification suspecte|vérifi(ez|cation) (votre identité|d'identité)|suspicious login|verify (it'?s|its) you|quick security check|let'?s do a (quick )?security check/i;

export const SESSION_CHECKS: Record<string, SessionCheck> = {
  linkedin: {
    homeUrl: 'https://www.linkedin.com/feed/',
    isLoginWallVisible: async (page) => {
      // Confirmed live: a real remote-login attempt landed on LinkedIn's
      // own "vérification d'identité suspecte" checkpoint (asking for a
      // one-time code) and this check reported success anyway -- neither
      // "on /login" nor "#username visible" matches that page (it's
      // neither the login form nor the authenticated feed), and it
      // apparently renders enough header chrome to also satisfy the
      // "hasNav = logged in" check below. A checkpoint/challenge/security
      // page is genuinely a THIRD state, not proof of either login or
      // logout, but treating it as "still not logged in" is the only safe
      // choice -- there is no usable, complete session to save from it.
      if (page.url().includes('/login') || page.url().includes('/uas/login') || page.url().includes('/checkpoint/')) {
        return true;
      }
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
      const currentUrl = page.url();
      if (currentUrl.includes('authentification-candidat.francetravail.fr')) return true;
      const onLoginForm = await page.locator('#identifiant, input[name="identifiant"]').first().isVisible().catch(() => false);
      if (onLoginForm) return true;
      const hasConnexionButton = await page
        .getByRole('button', { name: /^connexion/i })
        .or(page.getByRole('link', { name: /^connexion/i }))
        .first()
        .isVisible()
        .catch(() => false);
      if (hasConnexionButton) return true;

      // On the personal-space home page specifically (where the remote-login
      // flow sits while waiting for login to complete, matching
      // establish-session.js's own equivalent check), neither of the above
      // is enough: confirmed live that this exact flow's intermediate 2FA/
      // verification-code step shows NEITHER the identifiant form NOR a
      // "Connexion" button, which read as "logged in" the instant the
      // identifiant form disappeared -- well before the user actually
      // confirmed the code (a real false "Connexion réussie" before login
      // had finished). Requires a positive sighting of "Mon espace
      // personnel" (the dashboard's own heading) there instead. Scoped to
      // this URL only: that heading is dashboard-specific and would never
      // appear on an ordinary job-offer page, where this same check also
      // runs (from the real auto-apply flow, ensureLoggedIn below) while
      // genuinely logged in.
      if (page.url().includes('espacepersonnel')) {
        // Wait up to 15s to be absolutely sure the dashboard has had time to load,
        // rather than returning true (login wall visible) immediately if the network is slow.
        try {
          await Promise.race([
            page.locator('#identifiant').waitFor({ state: 'visible', timeout: 15000 }),
            page.getByText(/mon espace personnel/i).first().waitFor({ state: 'visible', timeout: 15000 })
          ]);
        } catch { /* Timeout, let the checks below decide */ }
        
        const onDashboard = await page.getByText(/mon espace personnel/i).first().isVisible().catch(() => false);
        const onLogin = await page.locator('#identifiant, input[name="identifiant"]').first().isVisible().catch(() => false);
        if (onLogin) return true;
        if (onDashboard) return false;
        
        // If neither showed up, check if the URL redirected to auth
        if (page.url().includes('authentification-candidat.francetravail.fr')) return true;
        
        return !onDashboard;
      }
      return false;
    },
  },
  welcome_to_the_jungle: {
    // The homepage itself for health-check navigation.
    homeUrl: 'https://www.welcometothejungle.com/fr',
    isLoginWallVisible: async (page) => {
      const url = page.url().toLowerCase();
      if (url.includes('/signin') || url.includes('/login') || url.includes('/authenticate')) {
        return true;
      }
      const hasSignInLink = await page.getByRole('link', { name: /se connecter/i }).first().isVisible().catch(() => false);
      if (hasSignInLink) return true;
      const hasSignInButton = await page.getByRole('button', { name: /se connecter/i }).first().isVisible().catch(() => false);
      if (hasSignInButton && !url.includes('/candidat/')) return true;
      return false;
    },
  },
  apec: {
    // Confirmed live via a real recorded session (a user-provided Chrome
    // DevTools Recorder export, not guessed): an anonymous visit to this
    // exact URL auto-opens APEC's own login popup (#popin-connexion) with
    // its #emailid/#password fields, the same popup the recording captured
    // being triggered from the "Mon espace" header link. That same
    // #emailid field also appears inline on the apply page itself when not
    // authenticated (see ApecApplier), so both share this one check.
    homeUrl: 'https://www.apec.fr/candidat/mon-espace.html',
    isLoginWallVisible: async (page) => page.locator('#emailid').first().isVisible().catch(() => false),
  },
  // Not used for continuous auto-polling the way every other platform's
  // check is (see remote-login.service.ts's MANUAL_CONFIRM_PLATFORMS) --
  // Google's own login is a multi-step flow (identifier -> password -> 2FA)
  // that repeatedly probing the DOM of is exactly the kind of automated
  // interaction Google actively fingerprints and penalizes accounts for.
  // Checked exactly once, only after the person themselves clicks "J'ai
  // terminé".
  gmail: {
    // Confirmed live: an anonymous visit here redirects to
    // accounts.google.com's own sign-in flow and stays there — URL-based,
    // not a DOM selector, since a real login here can pass through several
    // different-looking pages (email entry, password, 2FA) all on that
    // same host before finally redirecting back to mail.google.com.
    homeUrl: 'https://mail.google.com/mail/u/0/#inbox',
    isLoginWallVisible: async (page) => page.url().includes('accounts.google.com'),
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
  // Humanized click: a bare .click() here is a bot tell on platforms that
  // profile mouse trajectories (confirmed live: DataDome on WTTJ/APEC and
  // Cloudflare on Indeed both track this). Falls back to a plain click if
  // the element's bounding box can't be read (off-screen or not yet laid out).
  const box = await clickable.boundingBox().catch(() => null);
  if (box) {
    const x = box.x + box.width * (0.4 + Math.random() * 0.2);
    const y = box.y + box.height * (0.4 + Math.random() * 0.2);
    await page.mouse.move(x - 30 - Math.random() * 50, y - 15 - Math.random() * 30).catch(() => {});
    await page.waitForTimeout(80 + Math.random() * 100);
    await page.mouse.move(x, y, { steps: 6 }).catch(() => {});
    await page.waitForTimeout(60 + Math.random() * 80);
    await page.mouse.click(x, y).catch(() => clickable.click().catch(() => {}));
  } else {
    await clickable.click().catch(() => {});
  }
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
// (Greenhouse, Lever, Workday, SmartRecruiters, or something else entirely).
// Confirmed live via a real recorded session (a user-provided Chrome
// DevTools Recorder export): the real apply trigger is
// `[data-testid="job_header-button-apply"]`, not the `a[data-role="job:apply"]`
// this function used to read -- and it's a click target, not a plain link
// with a useful href: for an external offer, clicking it opens either a
// same-tab redirect or a popup (both observed across the two offers in that
// same recording), never just a static href to read cold. This is exactly
// what resolveExternalApplyUrl (used by every other account-based applier
// in this file for the identical "click it, see if it leaves the platform"
// problem) already handles -- reused here instead of a bespoke href check
// that would have missed a popup-based redirect entirely, called anonymously
// (this always runs in a disposable, logged-out context -- see
// auto-apply.service.ts's resolveEffectiveSourceUrl) so a native offer's
// same button instead redirects same-tab to `/fr/authenticate/signin`,
// still on welcometothejungle.com and correctly resolved to null.
export const WTTJ_APPLY_SELECTOR =
  '[data-testid="job_header-button-apply"], [data-testid="job_bottom-button-apply"], [data-testid*="button-apply"], [data-role="job:apply"], a:has-text("Postuler"), button:has-text("Postuler")';

export async function findWttjApplyButton(page: Page): Promise<Locator | null> {
  const loc = page.locator(WTTJ_APPLY_SELECTOR);
  const count = await loc.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) {
      return el;
    }
  }
  return null;
}

export async function resolveWelcomeToTheJungleApplyUrl(page: Page, jobPageUrl: string): Promise<string | null> {
  await page.goto(jobPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await dismissCookieBanner(page);
  await page.waitForTimeout(2000); // same WAF-challenge/SPA-hydration delay as the scraper's enrichment step
  const applyButton = await findWttjApplyButton(page);
  if (!applyButton) return null;
  return resolveExternalApplyUrl(page, applyButton, /welcometothejungle\.com/i);
}

/**
 * Universal 2FA / OTP handler for any provider (France Travail, LinkedIn, Indeed,
 * HelloWork, APEC, Welcome to the Jungle, or external ATS).
 *
 * 1. If presented with a choice of verification channels (App, SMS, Email), ALWAYS
 *    selects Email ("Recevoir un code par e-mail", "Email", etc.).
 * 2. Automatically queries the user's Gmail to fetch the security/verification OTP code.
 * 3. Enters the code into the verification input fields (segmented or single).
 * 4. Submits the verification form and awaits confirmation.
 */
export async function handleUniversalEmailOtp(
  page: Page,
  platform: string,
  userId: string,
  gmailOtp: GmailOtpService,
  logger?: { log: (msg: string) => void; warn: (msg: string) => void },
): Promise<boolean> {
  const log = (msg: string) => (logger ? logger.log(msg) : console.log(`[OTP] ${msg}`));
  const warn = (msg: string) => (logger ? logger.warn(msg) : console.warn(`[OTP] ${msg}`));

  try {
    // 1. Detect if page presents 2FA channel selection (App vs SMS vs Email)
    // Priority: ALWAYS choose Email
    const emailChannelSelectors = [
      '#canal-1', // France Travail direct email channel
      'a:has-text("Recevoir un code par e-mail")',
      'label:has-text("Recevoir un code par e-mail")',
      'input[type="radio"][value*="email" i]',
      'label:has-text("par e-mail")',
      'label:has-text("by email")',
      'button:has-text("par e-mail")',
      'button:has-text("by email")',
      'a:has-text("par e-mail")',
      'a:has-text("by email")',
      '[data-testid*="email" i]',
    ];

    for (const sel of emailChannelSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        log(`Found 2FA channel option [${sel}] — selecting email verification...`);
        await humanClick(page, el).catch(() => el.click().catch(() => {}));
        await page.waitForTimeout(2000);

        // Check if there is a button to trigger dispatching the email code
        const sendBtn = page
          .locator(
            '#submit, button[type="submit"], button:has-text("Poursuivre"), button:has-text("Continuer"), button:has-text("Envoyer"), button:has-text("Send"), button:has-text("Next"), button:has-text("Suivant")',
          )
          .first();
        if (await sendBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          const btnText = (await sendBtn.innerText().catch(() => '')).toLowerCase();
          if (
            btnText.includes('envoyer') ||
            btnText.includes('send') ||
            btnText.includes('suivant') ||
            btnText.includes('next')
          ) {
            await humanClick(page, sendBtn).catch(() => sendBtn.click().catch(() => {}));
            await page.waitForTimeout(3000);
          }
        }
        break;
      }
    }

    // 2. Detect OTP input fields on page
    // Case A: France Travail style 8 segmented inputs (#code-1 to #code-8)
    const code1 = page.locator('#code-1').first();
    const hasCode1 = await code1.isVisible({ timeout: 4000 }).catch(() => false);

    // Case B: General segmented inputs (e.g. 6 single-character inputs)
    const segmentedInputs = page.locator('input[maxlength="1"], input[data-index]');
    const segCount = await segmentedInputs.count().catch(() => 0);

    // Case C: Single OTP/PIN code field
    const singleCodeSelectors = [
      'input#code',
      'input#security-code',
      'input#pin',
      'input#verification-code',
      'input[name*="code" i]',
      'input[id*="code" i]',
      'input[name*="pin" i]',
      'input[id*="pin" i]',
      'input[name*="otp" i]',
      'input[type="tel"]',
      'input[autocomplete="one-time-code"]',
      'input[placeholder*="code" i]',
      'input[aria-label*="code" i]',
    ];

    let singleFieldLocator: Locator | null = null;
    if (!hasCode1 && segCount < 4) {
      for (const sel of singleCodeSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
          singleFieldLocator = el;
          break;
        }
      }
    }

    const hasAnyOtpInput = hasCode1 || segCount >= 4 || !!singleFieldLocator;
    if (!hasAnyOtpInput) {
      return false;
    }

    log(`2FA/OTP code entry detected for [${platform}] — polling Gmail for security code...`);
    const otpResult = await gmailOtp.fetchOtpForPlatform(platform, userId, {
      maxWaitSeconds: 50,
      since: new Date(Date.now() - 3 * 60 * 1000),
    });

    if (!otpResult?.code) {
      warn(`Could not retrieve OTP code from Gmail for [${platform}].`);
      return false;
    }

    const code = otpResult.code;
    log(`Retrieved OTP code [${code}] — entering into ${platform} verification form...`);

    if (hasCode1) {
      // Fill #code-1 through #code-8
      const digits = code.split('');
      for (let i = 0; i < Math.min(digits.length, 8); i++) {
        const digitInput = page.locator(`#code-${i + 1}`).first();
        if (await digitInput.isVisible().catch(() => false)) {
          await digitInput.fill(digits[i]);
          await page.waitForTimeout(80);
        }
      }
    } else if (segCount >= 4) {
      const digits = code.split('');
      for (let i = 0; i < Math.min(digits.length, segCount); i++) {
        const digitInput = segmentedInputs.nth(i);
        if (await digitInput.isVisible().catch(() => false)) {
          await digitInput.fill(digits[i]);
          await page.waitForTimeout(80);
        }
      }
    } else if (singleFieldLocator) {
      await humanFill(singleFieldLocator, code);
      await page.waitForTimeout(200);
    }

    // Submit the verification code
    const submitBtn = page
      .locator(
        '#submit, button[type="submit"], button:has-text("Poursuivre"), button:has-text("Valider"), button:has-text("Confirmer"), button:has-text("Vérifier"), button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continuer"), button:has-text("Continue")',
      )
      .first();

    if (await submitBtn.isVisible().catch(() => false)) {
      await humanClick(page, submitBtn).catch(() => submitBtn.click({ force: true }).catch(() => {}));
    } else {
      await page.keyboard.press('Enter');
    }

    log(`Submitted 2FA code for [${platform}]. Waiting for validation...`);
    await page.waitForTimeout(5000);

    // Handle post-OTP consent screen (e.g. France Travail: "Faire confiance à ce navigateur" for 3 months)
    const trustBtn = page
      .locator(
        'button:has-text("Faire confiance à ce navigateur"), a:has-text("Faire confiance à ce navigateur"), button:has-text("confiance")',
      )
      .first();
    if (await trustBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      log(`Found "Faire confiance à ce navigateur" button for [${platform}] — clicking to remember session for 3 months...`);
      await humanClick(page, trustBtn).catch(() => trustBtn.click({ force: true }).catch(() => {}));
      await page.waitForTimeout(4000);
    }

    return true;
  } catch (err: any) {
    warn(`Error in handleUniversalEmailOtp for ${platform}: ${err.message}`);
    return false;
  }
}

/**
 * Detects and automatically solves horizontal slide-to-verify challenges
 * (Arkose Labs, FunCaptcha, SmartRecruiters security challenge, etc.).
 * Drags the handle from left to right across the track.
 */
export async function trySolveSlideChallenge(page: Page): Promise<boolean> {
  try {
    let slideNotice: Locator | null = null;
    let targetFrame: any = page;

    // Search in main page and all frames
    for (const frame of [page, ...page.frames()]) {
      const noticeSelectors = [
        'text=/Slide right to secure/i',
        'text=/Glissez vers la droite/i',
        'text=/Glisser pour v.rifier/i',
        'text=/Faites glisser/i',
        '[aria-label*="slide" i]',
      ];
      for (const sel of noticeSelectors) {
        const notice = frame.locator(sel).first();
        if (await notice.isVisible({ timeout: 1000 }).catch(() => false)) {
          slideNotice = notice;
          targetFrame = frame;
          break;
        }
      }
      if (slideNotice) break;
    }

    if (!slideNotice) return false;

    // Find the slider button/handle
    const handleSelectors = [
      '[role="slider"]',
      '.slider',
      '.slider-btn',
      '.btn_slide',
      '[class*="slider" i] [class*="handle" i]',
      '[class*="slider" i] [class*="thumb" i]',
      '[class*="slider" i] [class*="button" i]',
      '[class*="secsdk" i] [class*="handle" i]',
      'div[class*="arrow" i]',
      'button[class*="slide" i]',
    ];

    let handle: Locator | null = null;
    for (const sel of handleSelectors) {
      const el = targetFrame.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        handle = el;
        break;
      }
    }

    if (!handle) {
      const nearbyButton = slideNotice
        .locator(
          'xpath=ancestor::*[contains(@class, "slide") or contains(@class, "sec") or contains(@class, "box") or contains(@class, "modal") or contains(@class, "card")][1]//button | ancestor::*[1]//div[contains(@class, "btn")]',
        )
        .first();
      if (await nearbyButton.isVisible().catch(() => false)) {
        handle = nearbyButton;
      }
    }

    if (!handle) return false;

    const handleBox = await handle.boundingBox().catch(() => null);
    if (!handleBox) return false;

    // Find track width from parent container or default ~260px
    const parent = handle.locator('xpath=..').first();
    const parentBox = await parent.boundingBox().catch(() => null);
    const dragDistance =
      parentBox && parentBox.width > handleBox.width + 40 ? parentBox.width - handleBox.width - 5 : 260;

    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;

    // Simulate natural human drag with easing and jitter
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    const steps = 25;
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const easeProgress = Math.sin((progress * Math.PI) / 2);
      const currentX = startX + dragDistance * easeProgress;
      const jitterY = startY + (Math.random() * 4 - 2);
      await page.mouse.move(currentX, jitterY, { steps: 2 });
      await page.waitForTimeout(15 + Math.floor(Math.random() * 20));
    }
    await page.mouse.up();
    await page.waitForTimeout(2500);

    const stillChallenged = await slideNotice.isVisible().catch(() => false);
    return !stillChallenged;
  } catch {
    return false;
  }
}

