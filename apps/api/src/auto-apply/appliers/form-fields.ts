import type { ElementHandle, Page } from 'playwright';

// The functions below run inside the browser page (Playwright serializes
// them into that context), never in Node — this project's tsconfig has no
// DOM lib, so `document`/`CSS` are declared locally rather than pulling DOM
// types into the whole backend just for this one file.
declare const document: any;
declare const CSS: any;

// Standard fields every applier already fills explicitly (name, email,
// phone, résumé upload, cover letter) — never reported as "unknown" even
// when their label matches loosely, and never overwritten by a learned
// answer (a learned "years of experience" answer must never land in the
// email field just because of a labeling quirk).
export const KNOWN_FIELD_LABEL_EXCLUDE =
  /first name|last name|full name|^name$|votre nom|votre pr[ée]nom|nom d'usage|nom de famille|nom de naissance|^e-?mail|courriel|adresse e-?mail|phone|t[ée]l[ée]phone|mobile|portable|num[ée]ro de (portable|t[ée]l[ée]phone|mobile)|resume|^cv$|cover letter|lettre de motivation|pr[ée]nom|^nom$|mot de passe|password|code de validation|captcha|se connecter|connexion|identifiant|civilit[ée]|gender|genre|salutation|titre de civilit[ée]|^country$|^pays$|votre pays|^currency$|^devise$|monnaie/i;

export interface DetectedField {
  questionText: string;
  fieldType: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'unknown';
  options: string[];
}

// These run inside the page (serialized by Playwright), not in Node — this
// project's tsconfig has no DOM lib, so the element is typed `any` here
// rather than pulling DOM types into the whole backend just for this file.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractLabel(el: any): string {
  const id = el.getAttribute('id');
  if (id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
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
}

// A radio GROUP's question text lives outside any single option (fieldset
// legend, or the nearest preceding text) -- mirrors the equivalent grouping
// logic in ai-form-snapshot.ts's buildFormSnapshotOnce, duplicated here for
// the same reason the rest of this file's DOM helpers are: these run
// serialized into the page context, not shared across the two files.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRadioGroupLabel(el: any): string {
  const fieldset = el.closest('fieldset');
  const legend = fieldset?.querySelector('legend');
  if (legend?.textContent?.trim()) return legend.textContent.trim();

  let current = el;
  for (let i = 0; i < 4; i++) {
    if (!current || current === document.body) break;
    const ariaLabelledby = current.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
      const lbl = document.getElementById(ariaLabelledby);
      if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
    }
    if (current.getAttribute('role') === 'group' && current.getAttribute('aria-label')) {
      return current.getAttribute('aria-label').trim();
    }
    current = current.parentElement;
  }

  current = el.parentElement;
  for (let i = 0; i < 4; i++) {
    if (!current || current === document.body) break;
    let prev = current.previousElementSibling;
    while (prev) {
      const text = prev.textContent?.trim();
      if (text && text.length > 2) return text;
      prev = prev.previousElementSibling;
    }
    current = current.parentElement;
  }
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isInvalid(el: any): boolean {
  if (el.getAttribute('aria-invalid') === 'true') return true;
  if ((el.required || el.getAttribute('aria-required') === 'true') && (!el.value || !el.value.trim())) return true;

  const describedBy = el.getAttribute('aria-describedby');
  if (describedBy) {
    for (const id of describedBy.split(/\s+/)) {
      const helper = document.getElementById(id);
      if (helper && helper.offsetParent !== null) {
        const txt = (helper.textContent || '').toLowerCase();
        if (/non valide|obligatoire|requis|invalide|error|required|invalid/.test(txt)) {
          return true;
        }
      }
    }
  }

  const container = el.closest('div, fieldset, li') || el.parentElement;
  if (!container) return false;

  const err = container.querySelector(
    '[role="alert"], .error-message, [class*="error" i], [class*="feedback" i], .artdeco-inline-feedback, [data-testid*="error" i], [data-testid*="helper-text" i]',
  );
  if (err && err.offsetParent !== null) {
    const txt = (err.textContent || '').toLowerCase();
    if (!/caract|reste|optionnel|max/i.test(txt)) return true;
  }

  const containerText = (container.textContent || '').toLowerCase();
  if (
    containerText.includes('saisie non valide') ||
    containerText.includes('ce champ est obligatoire') ||
    containerText.includes('champ obligatoire') ||
    containerText.includes('veuillez saisir') ||
    containerText.includes('veuillez renseigner') ||
    containerText.includes('veuillez choisir') ||
    containerText.includes('dates of employment')
  ) {
    return true;
  }

  return false;
}

const DIACRITICS_REGEX = new RegExp('[\\u0300-\\u036f]', 'g');

function normalizeLabel(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_REGEX, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Radio-group legends commonly concatenate the visible question text with a
// screen-reader-only duplicate of the exact same text, plus a trailing
// "Requis"/"Required" badge -- confirmed live on a LinkedIn Easy Apply
// screening question, whose captured label came back as the full question
// literally twice in a row followed by "Requis". Runs Node-side (after
// `.evaluate()` returns a plain string), not inside the page, so it applies
// uniformly to whatever DOM structure produced the duplication.
function cleanLabel(text: string): string {
  const trimmed = (text || '').replace(/\s+/g, ' ').trim();
  const noBadge = trimmed.replace(/\s*(requis|required)\s*$/i, '').trim();
  const half = Math.floor(noBadge.length / 2);
  if (half > 3 && noBadge.slice(0, half).trim() === noBadge.slice(half).trim()) {
    return noBadge.slice(0, half).trim();
  }
  return noBadge;
}

const FIELD_SELECTOR =
  'input:not([type=file]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=password]), textarea, select';

// Fills whatever the user has already answered once before (see
// CustomQuestionsService) — checked by normalized label text, so the same
// "How many years of experience with Python?" question is recognized
// across different job boards and companies.
// "35-40k" is a fine human answer and an invalid one for a numeric input
// (confirmed live on Michael Page: "Seules des valeurs numériques sont
// autorisées"). Takes the FIRST number of the answer, expands a k suffix.
export function numericFromAnswer(answer: string): string | null {
  const match = answer.replace(/\s/g, '').match(/(\d+(?:[.,]\d+)?)(k)?/i);
  if (!match) return null;
  let value = parseFloat(match[1].replace(',', '.'));
  if (match[2]) value *= 1000;
  return String(Math.round(value));
}

export async function fillKnownFields(page: Page, knownAnswers: Map<string, string>): Promise<void> {
  if (!knownAnswers.size) return;

  // Visible fields only, and a hard budget for the whole pass: confirmed
  // live on a career site's search page (Safran) that hidden filter inputs
  // matching a known label ("Ville") each burned a 3s hover timeout, and
  // the pass ran past 30s -- on every loop step.
  const deadline = Date.now() + 20000;
  const handles = await page.locator(FIELD_SELECTOR).elementHandles();
  for (const handle of handles) {
    if (Date.now() > deadline) break;
    if (!(await handle.isVisible().catch(() => false))) continue;
    await fillIfKnown(handle, knownAnswers).catch(() => {});
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fillIfKnown(handle: ElementHandle<any>, knownAnswers: Map<string, string>): Promise<void> {
  // (answer may be normalised below for numeric inputs)
  const type = await handle.evaluate((el) => el.type || '');
  if (type === 'password') return;

  if (type === 'radio') {
    // A radio option's own label is just "Oui"/"Non" -- the learned answer
    // is keyed by the GROUP's question text (matching how scanInvalidFields
    // now reports it), and the option to click is whichever one's own
    // label/value matches the stored answer text.
    const groupLabel = cleanLabel(await handle.evaluate(extractRadioGroupLabel));
    if (!groupLabel || KNOWN_FIELD_LABEL_EXCLUDE.test(groupLabel)) return;
    const answer = knownAnswers.get(normalizeLabel(groupLabel));
    if (!answer) return;
    const normalizedGroup = normalizeLabel(groupLabel);
    const extracted = cleanLabel(await handle.evaluate(extractLabel));
    const optionLabel = extracted && normalizeLabel(extracted) !== normalizedGroup ? extracted : '';
    const optionValue = await handle.evaluate((el) => el.value || '');
    if (normalizeLabel(optionLabel) === normalizeLabel(answer) || normalizeLabel(optionValue) === normalizeLabel(answer)) {
      await handle.evaluate((el) => { if (!el.checked) el.click(); });
    }
    return;
  }

  const label = await handle.evaluate(extractLabel);
  if (!label || KNOWN_FIELD_LABEL_EXCLUDE.test(label)) return;

  let answer = knownAnswers.get(normalizeLabel(label));
  if (!answer) return;

  const tag = await handle.evaluate((el) => el.tagName.toLowerCase());

  if (tag === 'select') {
    await handle.selectOption({ label: answer }, { timeout: 3000 }).catch(() => handle.selectOption(answer, { timeout: 3000 }).catch(() => {}));
  } else if (type === 'checkbox') {
    // Any truthy stored answer checks it -- a single checkbox has no
    // "options" to match against, unlike a radio group.
    await handle.evaluate((el) => { if (!el.checked) el.click(); });
  } else {
    // Confirmed live on a Lever form ("Twitter URL": "N/AN/AN/AN/A"): this
    // runs on every loop step and .type() APPENDS, so a field filled on
    // step 0 got the same answer stacked onto it on every later step. A
    // field that already holds anything is left alone, and a stored
    // answer that isn't a URL never goes into a URL field (the site
    // rejects it and the form can't validate).
    const current = await handle.evaluate((el) => (el.value || '').trim());
    if (current) return;
    if (type === 'number' || (await handle.evaluate((el) => (el.getAttribute('inputmode') || '') === 'numeric'))) {
      const numeric = numericFromAnswer(answer);
      if (!numeric) return;
      answer = numeric;
    }
    const isUrlField = type === 'url' || /\burl\b|\blien\b|\blink\b|twitter|linkedin|github|portfolio|website|site web/i.test(label) || /^x$/i.test(label.trim());
    if (isUrlField && !/^https?:\/\//i.test(answer.trim())) return;
    // Same "type it, don't just set the value" reasoning as
    // ats-common.ts's humanFill (a Locator-only API this ElementHandle-based
    // function can't call directly) -- .fill() here skips real keystroke
    // events and mouse movement entirely.
    try {
      // Bounded: Playwright's default is 30s PER action, and a known field
      // that happens to be covered or off-screen (a sticky "Paramètres
      // cookies" badge, a collapsed section) made each of these wait the
      // full 30s before the fallback -- several such fields ate a whole
      // attempt's budget with nothing in the log to show for it.
      await handle.hover({ timeout: 3000 });
      await handle.click({ timeout: 3000 });
      await handle.type(answer, { delay: 35 + Math.random() * 70, timeout: 3000 });
    } catch {
      await handle.fill(answer, { timeout: 3000 }).catch(() => {});
    }
    // Whatever an autocomplete/mask widget did with the keystrokes, the
    // field must end up holding the answer.
    const typed = await handle.evaluate((el) => (el.value || '').trim()).catch(() => null);
    if (typed !== null && typed !== answer.trim()) await handle.fill(answer, { timeout: 3000 }).catch(() => {});
  }
}

// Called after an applier detects it can't proceed (validation error on
// submit/next) — scans the currently-visible form for fields still marked
// invalid, so the exact question text can be stored for the user to answer
// once, instead of just recording "something was wrong".
export async function scanInvalidFields(page: Page): Promise<DetectedField[]> {
  const results: DetectedField[] = [];
  const seen = new Set<string>();

  // Radio groups get their own pass -- confirmed live that a required
  // LinkedIn screening radio ("travail hybride ?") never surfaced on the
  // Questions page at all: `isInvalid()` below only ever fires off a
  // SINGLE element's own `required`/empty-value state, but no individual
  // `<input type=radio>` option is ever itself required or has a
  // meaningful empty "value" -- the group as a whole is required, which is
  // a property only visible by looking at all its options together (none
  // checked).
  const radioHandles = await page.locator('input[type="radio"]').elementHandles();
  const groups = new Map<string, ElementHandle<any>[]>();
  for (const handle of radioHandles) {
    const visible = await handle.isVisible().catch(() => false);
    const disabled = await handle.evaluate((el: any) => !!el.disabled).catch(() => true);
    if (!visible || disabled) continue;
    const name = await handle.evaluate((el: any) => el.name || '').catch(() => '');
    const key = name || `__ungrouped_${groups.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(handle);
  }
  for (const options of groups.values()) {
    const checkedFlags = await Promise.all(
      options.map((o) => o.evaluate((el: any) => !!el.checked).catch(() => false)),
    );
    if (checkedFlags.some(Boolean)) continue; // already answered

    const groupLabel = cleanLabel(await options[0].evaluate(extractRadioGroupLabel).catch(() => ''));
    if (!groupLabel || KNOWN_FIELD_LABEL_EXCLUDE.test(groupLabel)) continue;

    const normalized = normalizeLabel(groupLabel);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const optionLabels: string[] = [];
    for (const o of options) {
      // extractLabel() falls back to the fieldset/legend when an option has
      // no label of its own -- indistinguishable here from the group label
      // itself, so that specific case is discarded in favor of the radio's
      // own `value` attribute instead of storing the group question twice.
      const extracted = cleanLabel(await o.evaluate(extractLabel).catch(() => ''));
      const value = await o.evaluate((el: any) => el.value || '').catch(() => '');
      const lbl = extracted && normalizeLabel(extracted) !== normalized ? extracted : value;
      if (lbl) optionLabels.push(lbl);
    }
    results.push({ questionText: groupLabel, fieldType: 'radio', options: optionLabels });
  }

  const handles = await page.locator(FIELD_SELECTOR).elementHandles();

  for (const handle of handles) {
    const type = await handle.evaluate((el) => el.type || '');
    if (type === 'radio') continue; // handled above as a group
    if (type === 'password') continue;

    const invalid = await handle.evaluate(isInvalid).catch(() => false);
    if (!invalid) continue;

    const label = await handle.evaluate(extractLabel).catch(() => '');
    if (!label || KNOWN_FIELD_LABEL_EXCLUDE.test(label)) continue;

    const normalized = normalizeLabel(label);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const tag = await handle.evaluate((el) => el.tagName.toLowerCase());

    let fieldType: DetectedField['fieldType'] = 'text';
    let options: string[] = [];
    if (tag === 'textarea') fieldType = 'textarea';
    else if (tag === 'select') {
      fieldType = 'select';
      options = await handle.evaluate((el) =>
        Array.from(el.options as any[]).map((o: any) => (o.textContent || '').trim()).filter(Boolean),
      );
    } else if (type === 'checkbox') fieldType = 'checkbox';

    results.push({ questionText: label, fieldType, options });
  }

  return results;
}

export { normalizeLabel };
