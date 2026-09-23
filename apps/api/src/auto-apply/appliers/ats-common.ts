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
// Above this, humanFill pastes instead of typing key by key (see there).
// ~200 chars is roughly the upper bound of anything a person would plausibly
// type into a form field by hand rather than paste.
const PASTE_THRESHOLD_CHARS = 200;

// An upload control with no reachable <input type=file> (confirmed live on
// Michael Page's "Joindre votre CV" box, required and left empty): clicking
// it opens the browser's file chooser, which the orchestrator answers with
// the CV for every attempt (see auto-apply.service.ts). Returns true when
// something was clicked.
export async function clickCvUploadControl(page: Page): Promise<boolean> {
  const control = page
    .locator('button, a, label, div[role="button"], span[role="button"], [class*="upload" i], [class*="dropzone" i]')
    .filter({ hasText: /joindre (votre|mon|un) cv|importe[rz] (votre|mon|un) cv|t[ée]l[ée]charge[rz] (votre|mon|un) cv|ajouter (votre|mon|un) cv|d[ée]poser (votre|mon|un) cv|attach (your |a )?(cv|resume)|upload (your |a )?(cv|resume)|choisir un fichier|s[ée]lect(ionner)?\.? (un )?fichier/i })
    .filter({ visible: true })
    .first();
  if (!(await control.isVisible().catch(() => false))) return false;
  const text = (await control.innerText().catch(() => '')).trim();
  if (text.length > 60) return false;
  await humanClick(page, control).catch(() => control.click({ timeout: 3000 }).catch(() => {}));
  await page.waitForTimeout(1500);
  return true;
}

// Mandatory consent boxes ("J'ai pris connaissance de la Politique de
// protection des données", "J'accepte les CGU"...) are ticked
// deterministically, before anything else: confirmed live on JCDecaux's
// ATS, where the CV-import and form buttons stay disabled until the box is
// checked, so nothing downstream could even start. Marketing/newsletter
// opt-ins are never touched.
const CONSENT_TEXT =
  /j'accepte|j'ai pris connaissance|je reconnais|je certifie|j'autorise|conditions g[ée]n[ée]rales|politique de (confidentialit[ée]|protection)|donn[ée]es personnelles|traitement de mes donn[ée]es|rgpd|i (agree|accept|acknowledge|have read)|privacy (policy|notice)|data protection|terms (and|&) conditions|consent to the/i;
const OPT_IN_TEXT = /newsletter|offres? (similaires|d'emploi par)|marketing|communications? commerciale|alerte|actualit[ée]s|promotion|partenaires/i;

export async function tickConsentCheckboxes(page: Page): Promise<number> {
  let ticked = 0;
  const boxes = page.locator('input[type="checkbox"]');
  const count = await boxes.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 20); i++) {
    const box = boxes.nth(i);
    const info = await box
      .evaluate((el: any) => {
        const r = el.getBoundingClientRect();
        const label = el.labels?.[0]?.textContent || el.closest('label')?.textContent || el.getAttribute('aria-label') || '';
        const container = el.closest('div, li, p, td, fieldset')?.textContent || '';
        return { checked: !!el.checked, visible: r.width > 0 && r.height > 0, text: `${label} ${container}`.replace(/\s+/g, ' ').slice(0, 400) };
      })
      .catch(() => null);
    if (!info || info.checked || !info.visible) continue;
    if (!CONSENT_TEXT.test(info.text) || OPT_IN_TEXT.test(info.text)) continue;
    await humanClick(page, box).catch(() => box.check({ timeout: 3000 }).catch(() => {}));
    if (await box.isChecked().catch(() => false)) ticked++;
  }
  return ticked;
}

// Cuts long text at a sentence/paragraph boundary under `limit`.
export function truncateAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  return (cut > limit * 0.5 ? slice.slice(0, cut + 1) : slice).trim();
}

export async function humanFill(locator: Locator, value: string): Promise<void> {
  if (!value) return;
  // Confirmed live on a Lila ATS form: a 1 300-char cover letter went into
  // "informations complémentaires" (max 1 000) and the whole form stayed
  // invalid. A field's own maxlength is the one limit that is always right.
  const maxLength = await locator.evaluate((e: any) => (typeof e.maxLength === 'number' && e.maxLength > 0 ? e.maxLength : 0)).catch(() => 0);
  if (maxLength && value.length > maxLength) value = truncateAtBoundary(value, maxLength);
  try {
    await locator.hover({ timeout: 3000 });
    await locator.click({ timeout: 3000 });
    // REPLACE semantics, like the .fill() this superseded -- pressSequentially
    // alone types at the caret and APPENDS to whatever's already there.
    // Confirmed live on a real WTTJ application: the AI form loop retried a
    // rejected field three times, and each pass stacked its value onto the
    // previous one ("Ousseynou KoneOusseynou KoneOusseynou Kone"), so the
    // form could never validate. Select-all + Backspace are real key events,
    // consistent with the rest of this function's reason for existing.
    const existing = await locator.inputValue({ timeout: 1000 }).catch(() => null);
    // Already holds exactly this value (a previous step, or the site's own
    // prefill): nothing to type. Typing it again is how a field ends up
    // doubled.
    if (existing === value) return;
    // Confirmed live on a Direct Emploi form (postal code "9345093450"):
    // select-all + Backspace is not guaranteed to empty a field -- a site
    // that hooks keydown, a masked input, or an inputValue() read that
    // timed out (so the old `if (existing)` skipped the clear entirely)
    // all leave the previous text in place, and the keystrokes below then
    // append to it. Clear unconditionally, check the result, and fall back
    // to a direct clear when the key events didn't take.
    await locator.press('Control+a').catch(() => {});
    await locator.press('Backspace').catch(() => {});
    const afterClear = await locator.inputValue({ timeout: 1000 }).catch(() => null);
    if (afterClear) await locator.fill('').catch(() => {});
    // Per-key typing is only realistic for short values. A ~1500-char cover
    // letter at 35-105ms per key is 50-160 seconds -- longer than the whole
    // attempt's 120s budget, and six appliers pass exactly that through
    // here. No person types a cover letter into a form either; they paste
    // it, which is one input event carrying the whole text -- precisely what
    // fill() emits. Short values (names, emails, a URL) keep the keystroke
    // cadence; long ones get a paste.
    // Confirmed live on HelloWork's phone widget (an intl-tel-input style
    // field with a fixed "+33" prefix that re-renders on every keystroke):
    // per-key typing got 6 characters in and then ate the attempt's whole
    // 150s budget, one stalled key press at a time. A phone/number widget
    // gets its value as one input event (what a paste is), and any other
    // field that stops accepting keystrokes falls back to the same instead
    // of waiting Playwright's default 30s on each remaining key.
    // Keystrokes go to whatever the PAGE considers focused, not to this
    // locator -- so a site that restores focus asynchronously after a click
    // gets the first characters of this value typed into the field that was
    // focused before. Confirmed live on alphea-conseil.com: the email field
    // came out as "ousseynou781227@gmail.com" + "Mad", and on the retry the
    // city field as "Ile de Saint Denis" + "ousseynou7" -- each field holding
    // the start of the NEXT field's value, which made the form invalid and
    // cost the whole candidature. Nothing is typed until the element really
    // is the active one.
    for (let attempt = 0; attempt < 5; attempt++) {
      const isFocused = await locator.evaluate((e: any) => e === e.ownerDocument.activeElement).catch(() => false);
      if (isFocused) break;
      await locator.focus({ timeout: 1000 }).catch(() => {});
      await locator.page().waitForTimeout(100);
    }

    const inputType = await locator.evaluate((e: any) => (e.type || '').toLowerCase()).catch(() => '');
    if (value.length > PASTE_THRESHOLD_CHARS || inputType === 'tel') {
      await locator.fill(value);
    } else {
      try {
        await locator.pressSequentially(value, { delay: 35 + Math.random() * 70, timeout: 3000 });
      } catch {
        await locator.fill(value);
      }
      // Confirmed live on Adzuna's location box ("Ile-de-France,
      // FranIle-de-Francece"): an autocomplete widget moved the caret
      // mid-typing and the keystrokes landed in the middle of its own
      // suggestion. Whatever the widget did, the field must end up holding
      // the value -- one replacing input event when it doesn't.
      const typed = await locator.inputValue({ timeout: 1000 }).catch(() => null);
      if (typed !== null && typed.trim() !== value.trim()) await locator.fill(value).catch(() => {});
    }
  } catch {
    await locator.fill(value).catch(() => {});
  }
}

// A phone field that already shows the country code ("+33" as a fixed
// prefix, a "France (+33)" selector next to it, or a "6 12 34 56 78"
// placeholder) expects the NATIONAL number without its leading 0 --
// "+33 0630..." is what HelloWork's widget was left with. Read the field's
// surroundings and strip the 0 only in that case.
// Phone widgets are the single most hostile input seen live (HelloWork's:
// a fixed "+33" prefix, a keystroke filter that silently drops characters,
// "Certains caractères ne sont pas acceptés" for a perfectly normal
// number). One value + one typing strategy is not enough: each candidate
// format is set as a single input event, then the field is READ BACK and
// the surrounding error text checked, and the first format the widget
// keeps wins. Order: national without the leading 0 when a country prefix
// is shown, then the plain 10-digit form, then E.164.
export async function fillPhoneRobustly(locator: Locator, phone: string, exclude: string[] = []): Promise<void> {
  const digits = phone.replace(/[^\d+]/g, '');
  const national10 = digits.replace(/^\+33/, '0').replace(/^33(?=\d{9}$)/, '0');
  const national9 = national10.replace(/^0/, '');
  const preferNational9 = (await phoneValueForField(locator, phone)) === national9;
  const candidates = [...new Set(preferNational9 ? [national9, national10, `+33${national9}`] : [national10, national9, `+33${national9}`])].filter(
    (c) => !exclude.includes(c),
  );
  for (const candidate of candidates) {
    await locator.click({ timeout: 3000 }).catch(() => {});
    await locator.fill('').catch(() => {});
    await locator.fill(candidate).catch(() => {});
    await locator.press('Tab').catch(() => {});
    await locator.page().waitForTimeout(400);
    const value = (await locator.inputValue({ timeout: 1000 }).catch(() => '')) || '';
    const kept = value.replace(/\D/g, '');
    // Confirmed live (Direct Emploi): a widget that prepends its own "0"
    // turned the 10-digit form into "00630062429" -- 11 digits, which the
    // old ">= 9 digits" test happily accepted. Only the three shapes of a
    // valid French number are.
    const acceptable = new Set([national10, national9, `33${national9}`]);
    if (!acceptable.has(kept)) continue;
    const errorNearby = await locator
      .evaluate((el: any) => {
        const box = el.closest('div, fieldset, li') || el.parentElement;
        const text = (box?.textContent || '').toLowerCase();
        return /non valide|invalide|pas accept|incorrect|invalid|format/.test(text);
      })
      .catch(() => false);
    if (!errorNearby) return;
  }
}

export async function phoneValueForField(locator: Locator, phone: string): Promise<string> {
  const digits = phone.replace(/[^\d+]/g, '');
  const hasCountryPrefix = await locator
    .evaluate((el: any) => {
      const own = `${el.value || ''} ${el.getAttribute('placeholder') || ''}`;
      const around = el.closest('div, fieldset, label, li')?.textContent || '';
      const prev = el.previousElementSibling?.textContent || '';
      return /\+33|\(33\)|\bFR\b/.test(`${own} ${around.slice(0, 120)} ${prev}`) || /^\s*[1-9] \d\d /.test(el.getAttribute('placeholder') || '');
    })
    .catch(() => false);
  if (!hasCountryPrefix) return phone;
  return digits.replace(/^\+33/, '').replace(/^0/, '');
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

const IMAGE_FILE_INPUT_TEXT = /photo|image|avatar|picture|portrait|logo|selfie/i;
const CV_FILE_INPUT_TEXT = /\bcv\b|r[ée]sum[ée]|curriculum|resume/i;

// The file input the CV belongs in -- NOT simply the first one on the page.
// Confirmed live on two Welcome to the Jungle applications: the form's
// first <input type=file> is the optional "Photo de profil", the PDF went
// in there ("Format non pris en charge. Vous pouvez télécharger : gif,
// jpeg, png, svg"), the real CV field stayed empty and the submission
// never validated. Skips any input that only accepts images or is
// labelled as a photo, prefers one explicitly labelled CV/résumé or
// accepting PDF/Word, and otherwise takes the first remaining one.
export async function findCvFileInput(scope: Page | Locator): Promise<Locator | null> {
  const inputs = scope.locator('input[type="file"]');
  const count = await inputs.count().catch(() => 0);
  let fallback: Locator | null = null;
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const meta = await input
      .evaluate((el: any) => {
        const id = el.getAttribute('id');
        const forLabel = id ? (document.querySelector(`label[for="${(globalThis as any).CSS?.escape ? (globalThis as any).CSS.escape(id) : id}"]`)?.textContent || '') : '';
        const wrapping = el.closest('label')?.textContent || '';
        const container = el.closest('div, fieldset, section, li')?.textContent || '';
        return {
          accept: (el.getAttribute('accept') || '').toLowerCase(),
          text: `${el.getAttribute('name') || ''} ${id || ''} ${el.getAttribute('aria-label') || ''} ${forLabel} ${wrapping} ${container.slice(0, 200)}`,
        };
      })
      .catch(() => null);
    if (!meta) continue;
    const imageOnly = !!meta.accept && meta.accept.split(',').every((t) => /image|\.(png|jpe?g|gif|svg|webp)$/.test(t.trim()));
    if (imageOnly || (IMAGE_FILE_INPUT_TEXT.test(meta.text) && !CV_FILE_INPUT_TEXT.test(meta.text))) continue;
    if (CV_FILE_INPUT_TEXT.test(meta.text) || /pdf|doc|msword|officedocument/.test(meta.accept)) return input;
    if (!fallback) fallback = input;
  }
  return fallback;
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
async function scanIdentityFields(page: Page): Promise<{ role: IdentityRole; idx: number; tag: string; selector: string | null }[]> {
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

    const matches: { role: IdentityRole; idx: number; tag: string; selector: string | null }[] = [];
    const existingIdxs = Array.from(doc.querySelectorAll('[data-identity-idx]')).map(
      (e: any) => Number(e.getAttribute('data-identity-idx')) || 0,
    );
    let idx = existingIdxs.length ? Math.max(...existingIdxs) + 1 : 1;
    // Scoped to the application region when one was identified (see
    // markApplicationRoot), so a page that also carries a contact sidebar or
    // a newsletter popup doesn't get those filled with the candidate's
    // details. Falls back to the whole document when no region stands out,
    // which is every ordinary single-form page.
    const scopeEl = doc.querySelector('[data-ai-root]') || doc;
    const candidates = Array.from(
      scopeEl.querySelectorAll(
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
      // Confirmed live on a Figaro Classifieds form ("KoneKoneKoneKoneKone"):
      // a widget whose .value never reflects what it displays looks empty on
      // every loop step, so this ran again and again and the name stacked up
      // five times. A field this attempt already filled is done, whatever
      // its .value says.
      if (el.hasAttribute('data-identity-filled')) continue;

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
      // `full` before `last`: "Nom complet" also matches the last-name
      // pattern (^nom) and was getting just "Kone" -- confirmed live.
      else if (compiled.full.test(haystack)) role = 'full';
      else if (compiled.first.test(haystack)) role = 'first';
      else if (compiled.last.test(haystack)) role = 'last';
      if (!role) continue;

      const tagIdx = idx++;
      el.setAttribute('data-identity-idx', String(tagIdx));
      // A stable selector alongside the tag: React/Angular forms
      // (SmartRecruiters, confirmed live on "Confirmez votre e-mail") can
      // re-render the input between this scan and the fill, and a re-created
      // node no longer carries the tag attribute -- the fill then finds
      // nothing and silently skips.
      const esc = (globalThis as any).CSS?.escape;
      const selector = id ? `#${esc ? esc(id) : id}` : name ? `${tag}[name="${name.replace(/"/g, '\\"')}"]` : null;
      matches.push({ role, idx: tagIdx, tag, selector });
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
  scope?: Page | Locator,
): Promise<void> {
  const area = scope ?? page;
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

  // A server-side "phone invalid" verdict only shows after a submit
  // (confirmed live on a WP Job Manager form: "Téléphone: Veuillez saisir
  // un numéro" for "+33 0630062429"). The field is no longer empty, so the
  // scan below would leave it alone; re-fill it with the NEXT format instead.
  const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  if (/t[ée]l[ée]phone[^.\n]{0,60}(saisir|invalide|valide|incorrect|obligatoire|requis)|(invalid|enter a valid) phone/i.test(bodyText) && cv.phone) {
    const phoneFields = page.locator('input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="tel" i], input[id*="tel" i]');
    const count = await phoneFields.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const field = phoneFields.nth(i);
      if (!(await field.isVisible().catch(() => false))) continue;
      const current = (await field.inputValue().catch(() => '')).replace(/\s+/g, '');
      await fillPhoneRobustly(field, cv.phone, [current, current.replace(/^\+33/, '0')]);
      await field.evaluate((el: any) => el.setAttribute('data-identity-filled', '1')).catch(() => {});
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const matches = await scanIdentityFields(page).catch(() => []);
    for (const m of matches) {
      const value = values[m.role];
      if (!value) continue;
      const tagged = page.locator(`[data-identity-idx="${m.idx}"]`).first();
      const locator = (await tagged.count().catch(() => 0)) > 0 || !m.selector ? tagged : page.locator(m.selector).first();
      if (m.tag === 'select') {
        await selectOptionRobustly(locator, m.role, value);
      } else {
        if (m.role === 'phone') await fillPhoneRobustly(locator, value);
        else await humanFill(locator, value);
      }
      await locator.evaluate((el: any) => el.setAttribute('data-identity-filled', '1')).catch(() => {});
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
// Confirmed live on handicap-job.com (a "Bienvenue dans Handicap-Job"
// consent modal with "Gérer les options" / "Autoriser"): the wording is
// not always some form of "accepter" -- "autoriser", "OK", "j'ai compris"
// and "continuer" all appear on real career-site CMPs, and a banner that
// isn't recognised stays on top of the form for the entire attempt.
const COOKIE_ACCEPT_TEXT =
  /tout accepter|accepter tout|accepter les cookies|^accepter$|accepter (&|et) (fermer|continuer)|j'accepte|^autoriser$|tout autoriser|autoriser tou(s|t)( les cookies)?|autoriser (&|et) (fermer|continuer)|^ok$|^ok pour moi$|^d'accord$|j'ai compris|^compris$|^continuer$|accept all|accept cookies|^accept$|accept (&|and) (close|continue)|allow all|^allow$|i agree|^agree$|^got it$/i;

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
    .locator(
      '#didomi-notice-agree-button, #onetrust-accept-btn-handler, #pe-cookies-accept, #pe-cookies-refuse, #axeptio_btn_acceptAll, ' +
        '#tarteaucitronPersonalize2, .tarteaucitronAllow, #CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, ' +
        '.qc-cmp2-summary-buttons button[mode="primary"], button[data-cky-tag="accept-button"], .cc-btn.cc-allow, #cookiescript_accept',
    )
    .first();
  if (await explicitCmp.isVisible().catch(() => false)) {
    // Same human-like path as every other click here -- a consent button
    // is the very first thing clicked on a page, exactly where a bare
    // .click() with no mouse trajectory stands out.
    await humanClick(page, explicitCmp).catch(() => explicitCmp.click().catch(() => {}));
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
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
  // Confirmed live on talents-handicap.com: "Refuser" / "Accepter" are not
  // <button>s at all, so getByRole('button') never saw them and the modal
  // sat over the page for the whole attempt. Any clickable element whose
  // own text is the accept wording counts.
  if (!acceptButton) {
    const looseMatches = await page
      .locator('a, div[onclick], span[onclick], [role="button"], input[type="button"], input[type="submit"], button')
      .filter({ hasText: COOKIE_ACCEPT_TEXT })
      .all()
      .catch(() => []);
    for (const candidate of looseMatches) {
      const text = (await candidate.innerText().catch(() => '')).trim();
      if (text.length > 40 || !COOKIE_ACCEPT_TEXT.test(text)) continue;
      if (await candidate.isVisible().catch(() => false)) {
        acceptButton = candidate;
        break;
      }
    }
  }
  // Some CMPs (Sourcepoint, some Didomi/Quantcast setups) render the whole
  // dialog inside an iframe, where page-level locators never look.
  if (!acceptButton) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      for (const candidate of await frame.getByRole('button', { name: COOKIE_ACCEPT_TEXT }).all().catch(() => [])) {
        if (await candidate.isVisible().catch(() => false)) {
          acceptButton = candidate;
          break;
        }
      }
      if (acceptButton) break;
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
// "why have i been blocked" / "you have been blocked": Cloudflare's hard
// block page (seen live on Safran's ATS through WTTJ) -- not a challenge
// that can be passed, but still a security wall, and the note should say
// so rather than "no form found".
const SECURITY_CHECK_TEXT = /échec de la vérification|browser check failed|verify you are human|unusual activity|security check|vérification supplémentaire|prouvez que vous êtes humain|validate you are human|vérification de sécurité en cours|vérifiez que vous êtes humain|why have i been blocked|you have been blocked|attention required!? \| cloudflare|access denied \| /i;

export async function hasSecurityCheck(page: Page): Promise<boolean> {
  const checkOnce = async () => {
    if (SECURITY_CHECK_TEXT.test(page.url())) {
      console.log('SECURITY CHECK TRIGGERED BY URL:', page.url());
      return true;
    }
    if (/datadome/i.test(page.url())) {
      console.log('SECURITY CHECK TRIGGERED BY DATADOME URL:', page.url());
      return true;
    }
    for (const frame of page.frames()) {
      // Background telemetry iframes often contain 'datadome' or 'captcha' without actually blocking the user.
      // We rely on the body text check below to see if the user is actually being challenged.
    }
    const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    const match = bodyText.match(SECURITY_CHECK_TEXT);
    if (match) {
      console.log('SECURITY CHECK TRIGGERED BY BODY TEXT:', match[0]);
      return true;
    }
    return false;
  };

  let hasCheck = await checkOnce();
  if (!hasCheck) return false;

  // Transient checks (Cloudflare "Just a moment...", Datadome interstitial) 
  // often clear automatically after 3-8 seconds for stealth browsers.
  // Poll before declaring it blocked.
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000);
    hasCheck = await checkOnce();
    if (!hasCheck) return false;
  }
  return true;
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
      if (/\/login|\/uas\/login|\/checkpoint\/|\/signup|\/authwall|\/start\/join/i.test(page.url())) {
        return true;
      }
      if (await page.locator('#username').isVisible().catch(() => false)) return true;
      // Confirmed live from an apply-time screenshot: a dead li_at cookie
      // sends a job URL to LinkedIn's full-page SIGNUP ("Inscrivez-vous sur
      // LinkedIn, c'est gratuit" / "Déjà inscrit(e) ? S'identifier") --
      // neither the login form nor the feed, and none of the checks here
      // matched it, so the applier reported "no apply button" and the
      // orchestrator then saved that logged-out state as a healthy session.
      const signupHeading = await page
        .getByText(/inscrivez[- ]vous sur linkedin|join linkedin|nouveau sur linkedin|new to linkedin|d[ée]j[àa] inscrit|already on linkedin/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (signupHeading) return true;

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
    isLoginWallVisible: async (page) => {
      // Confirmed live: when Indeed recognises the account it skips the
      // email form and shows "Nous sommes ravis de vous revoir" with only a
      // "Continuer avec Google" button -- no email input at all -- and the
      // old input-only check read that as "logged in" and saved the session
      // before the person had even signed in. Every Indeed auth screen
      // (email, password, one-time code, this welcome-back page) lives on
      // secure.indeed.com, and the Google/Apple SSO detours on their own
      // domains; a real session lands on myjobs.indeed.com. The URL is the
      // reliable signal; the input is only a fallback.
      if (/secure\.indeed\.com|accounts\.google\.com|appleid\.apple\.com/i.test(page.url())) return true;
      return page.locator('#login-email-input, input[name="__email"]').first().isVisible().catch(() => false);
    },
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
  free_work: {
    // /fr/resume is the candidate's own résumé page -- logged out, it's
    // where "Se connecter" (see freework.applier.ts's login form,
    // confirmed live via screenshot: a visible input[type=password]) shows
    // up instead of the résumé itself.
    //
    // Confirmed live the hard way: a stale/wrong REMOTE_LOGIN_URLS entry
    // sent a real remote-login attempt to a genuine 404 on free-work.com's
    // own side (a branded error page, not a browser-level error
    // isBrowserErrorPage would have caught) -- no password field there
    // either, so "not on the login wall" fired after two clean reads and
    // that error page's cookies got saved as a working session. A password
    // field being absent is never enough on its own; the URL must also
    // still be on the résumé page, not bounced to /login or an error page.
    homeUrl: 'https://www.free-work.com/fr/resume',
    isLoginWallVisible: async (page) => {
      if (/\/login(\?|$)/i.test(page.url())) return true;
      if (await page.locator('input[type="password"]:visible').first().isVisible().catch(() => false)) return true;
      const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
      if (/404|server error|page (introuvable|non trouv[ée]e)/i.test(bodyText)) return true;
      return !/\/fr\/resume/i.test(page.url());
    },
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
// The second half is the "landed on a search page instead of the posting"
// case: confirmed live on an Atos career site (WTTJ redirect) whose
// job URL now answers "Il n'y a actuellement aucun poste vacant
// correspondant" over its own search form -- which the generic applier
// then filled in. Search-results wording is only read as "gone" when no
// application form is on the page (see hasJobClosedIndicator's callers).
const JOB_CLOSED_TEXT =
  /no longer accepting applications|n'accepte plus de candidatures|ne recrute plus|offre n'est plus disponible|this job (is no longer available|has expired)|offre expirée|candidatures closes|aucun poste vacant correspondant|cette offre (d'emploi )?n'existe plus|l'offre que vous recherchez n'existe (plus|pas)|poste (a été |a été déjà )?pourvu|n'est plus d'actualité|position has been filled|job (posting )?(not found|no longer exists|has been closed)|this (job|position) is closed|we're sorry.{0,40}(no longer|not available)/i;

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
    // Confirmed live (Indeed -> talents-handicap.com): the first URL the
    // popup reports is an intermediate hop of a redirect chain, and the
    // attempt then "applied" on the employer's HOMEPAGE. Give the chain a
    // bounded moment to settle and re-read; if it still ends on a bare
    // domain root, that's not a job page.
    await popup.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    // Confirmed live on Indeed ("Continuer pour postuler"): the popup
    // first lands on the platform's OWN redirector (indeed.com/applystart)
    // and only then hops to the employer -- read at the wrong moment, the
    // hop looked like "never left the platform". Poll until it does.
    const isBareRoot = (u: string) => {
      try {
        const p = new URL(u);
        return p.pathname === '/' || p.pathname === '';
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 10 && (ownDomain.test(popup.url()) || popup.url() === 'about:blank'); i++) {
      await popup.waitForTimeout(1000);
    }
    // Confirmed live (Indeed -> free-work.com): leaving Indeed's domain was
    // enough to stop the loop above even though the chain had only reached
    // the employer's bare homepage so far, one hop short of the real job
    // page -- the applier then dutifully "applied" on that homepage's
    // "Postuler" (there wasn't one). Give a bare root the same bounded
    // chance to keep hopping that an on-Indeed intermediate URL already got.
    for (let i = 0; i < 6 && isBareRoot(popup.url()); i++) {
      await popup.waitForTimeout(1000);
    }
    const url = popup.url();
    await popup.close().catch(() => {});
    if (!url || ownDomain.test(url) || url === 'about:blank' || isBareRoot(url)) return null;
    return url;
  }

  // Same-tab case: give a redirector hop the same chance.
  for (let i = 0; i < 4 && ownDomain.test(page.url()); i++) await page.waitForTimeout(1000);
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

// The server-rendered "Postuler" link on a WTTJ job page reads
// href="/fr/authenticate/signin" for EVERY offer; only client-side
// hydration swaps in the employer's real ATS URL (plus an "ExternalLink"
// icon) on an external one. Confirmed live: an external FERCHAU offer read
// as on-site 2s after domcontentloaded, got clicked as if native, and WTTJ
// answered with its "Avez-vous postulé à ce job ?" tracker modal while the
// real form opened in a tab nobody was driving. Waits for the network to
// settle (bounded) so the link is read in its final state.
export async function waitForWttjHydration(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
}

export async function resolveWelcomeToTheJungleApplyUrl(page: Page, jobPageUrl: string): Promise<string | null> {
  await page.goto(jobPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await dismissCookieBanner(page);
  await page.waitForTimeout(2000); // same WAF-challenge/SPA-hydration delay as the scraper's enrichment step
  await waitForWttjHydration(page);
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
    ].join(', ');

    const el = page.locator(emailChannelSelectors).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      log(`Found 2FA channel option — selecting email verification...`);
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
    ].join(', ');

    let singleFieldLocator: Locator | null = null;
    if (!hasCode1 && segCount < 4) {
      const el = page.locator(singleCodeSelectors).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        singleFieldLocator = el;
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
// Cloudflare Turnstile ("Vérifiez que vous êtes humain" checkbox), seen
// live on Indeed through the host Chrome. The widget lives in a
// cross-origin iframe behind a closed shadow root, so no locator reaches
// the checkbox itself -- but a real mouse click on the box's left edge is
// exactly what a person does, and a genuine Chrome usually passes on that.
// Returns true when the challenge is gone afterwards. Never loops.
export async function tryClickTurnstile(page: Page): Promise<boolean> {
  const frameEl = page.locator('iframe[src*="challenges.cloudflare.com"], iframe[title*="Turnstile" i], iframe[title*="Cloudflare" i]').first();
  if (!(await frameEl.isVisible().catch(() => false))) return false;
  const box = await frameEl.boundingBox().catch(() => null);
  if (!box) return false;
  const x = box.x + 28 + Math.random() * 6;
  const y = box.y + box.height / 2 + (Math.random() * 6 - 3);
  await page.mouse.move(x - 60 - Math.random() * 40, y - 30 - Math.random() * 20).catch(() => {});
  await page.waitForTimeout(120 + Math.random() * 150);
  await page.mouse.move(x, y, { steps: 10 }).catch(() => {});
  await page.waitForTimeout(80 + Math.random() * 120);
  await page.mouse.click(x, y).catch(() => {});
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1000);
    const stillThere = await frameEl.isVisible().catch(() => false);
    const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    if (!stillThere && !SECURITY_CHECK_TEXT.test(bodyText)) return true;
  }
  return false;
}

export async function trySolveSlideChallenge(page: Page): Promise<boolean> {
  try {
    let slideNotice: Locator | null = null;
    let targetFrame: any = page;

    // Combine selectors to avoid N*1000ms delays when no captcha is present
    const combinedSelector = [
      'text=/Slide right to secure/i',
      'text=/Glissez vers la droite/i',
      'text=/Glisser pour v.rifier/i',
      'text=/Faites glisser/i',
      '[aria-label*="slide" i]',
    ].join(', ');

    for (const frame of [page, ...page.frames()]) {
      const notice = frame.locator(combinedSelector).first();
      if (await notice.isVisible({ timeout: 1000 }).catch(() => false)) {
        slideNotice = notice;
        targetFrame = frame;
        break;
      }
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

    // Move to the handle with a human-like approach rather than a teleport
    await page.mouse.move(startX - 20 - Math.random() * 30, startY - 10 - Math.random() * 20);
    await page.waitForTimeout(100 + Math.random() * 150);
    await page.mouse.move(startX, startY, { steps: 5 + Math.floor(Math.random() * 5) });
    await page.waitForTimeout(100 + Math.random() * 200); // Pause before pressing
    
    await page.mouse.down();
    await page.waitForTimeout(50 + Math.random() * 100); // Hold for a moment

    // Target X is the destination, but humans often overshoot slightly and correct
    const targetX = startX + dragDistance;
    const overshootX = targetX + (Math.random() * 10 + 5); 

    const steps = 30 + Math.floor(Math.random() * 10);
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      // Use an ease-in-out or custom easing to simulate acceleration then deceleration
      const easeProgress = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      
      let currentX = startX + (overshootX - startX) * easeProgress;
      
      // If we are at the very end, correct the overshoot backwards
      if (i > steps - 5) {
          const correctionProgress = (i - (steps - 5)) / 5;
          currentX = overshootX - (overshootX - targetX) * correctionProgress;
      }

      const jitterY = startY + (Math.random() * 6 - 3); // Slightly more vertical jitter
      await page.mouse.move(currentX, jitterY, { steps: 1 });
      await page.waitForTimeout(10 + Math.floor(Math.random() * 25)); // Variable speed
    }
    
    await page.waitForTimeout(100 + Math.random() * 150); // Pause at the end of the slide
    await page.mouse.up();
    await page.waitForTimeout(3000);

    const stillChallenged = await slideNotice.isVisible().catch(() => false);
    return !stillChallenged;
  } catch {
    return false;
  }
}

