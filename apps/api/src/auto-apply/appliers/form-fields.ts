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
const KNOWN_FIELD_LABEL_EXCLUDE =
  /first name|last name|full name|^name$|^e-?mail|courriel|adresse e-?mail|phone|t[ée]l[ée]phone|mobile|resume|^cv$|cover letter|lettre de motivation|pr[ée]nom|^nom$|mot de passe|password|code de validation|captcha|se connecter|connexion|identifiant/i;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isInvalid(el: any): boolean {
  if (el.getAttribute('aria-invalid') === 'true') return true;

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
  if (containerText.includes('saisie non valide') || containerText.includes('ce champ est obligatoire')) {
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

const FIELD_SELECTOR =
  'input:not([type=file]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=password]), textarea, select';

// Fills whatever the user has already answered once before (see
// CustomQuestionsService) — checked by normalized label text, so the same
// "How many years of experience with Python?" question is recognized
// across different job boards and companies.
export async function fillKnownFields(page: Page, knownAnswers: Map<string, string>): Promise<void> {
  if (!knownAnswers.size) return;

  const handles = await page.locator(FIELD_SELECTOR).elementHandles();
  for (const handle of handles) {
    await fillIfKnown(handle, knownAnswers).catch(() => {});
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fillIfKnown(handle: ElementHandle<any>, knownAnswers: Map<string, string>): Promise<void> {
  const label = await handle.evaluate(extractLabel);
  if (!label || KNOWN_FIELD_LABEL_EXCLUDE.test(label)) return;

  const answer = knownAnswers.get(normalizeLabel(label));
  if (!answer) return;

  const tag = await handle.evaluate((el) => el.tagName.toLowerCase());
  const type = await handle.evaluate((el) => el.type || '');
  if (type === 'password') return;

  if (tag === 'select') {
    await handle.selectOption({ label: answer }).catch(() => handle.selectOption(answer).catch(() => {}));
  } else if (type === 'radio' || type === 'checkbox') {
    // The answer is expected to match this option's own label/value for
    // radio groups; for a single checkbox, any truthy answer checks it.
    const optionLabel = await handle.evaluate(extractLabel);
    if (type === 'checkbox' || normalizeLabel(optionLabel) === normalizeLabel(answer)) {
      await handle.evaluate((el) => el.click());
    }
  } else {
    await handle.fill(answer).catch(() => {});
  }
}

// Called after an applier detects it can't proceed (validation error on
// submit/next) — scans the currently-visible form for fields still marked
// invalid, so the exact question text can be stored for the user to answer
// once, instead of just recording "something was wrong".
export async function scanInvalidFields(page: Page): Promise<DetectedField[]> {
  const handles = await page.locator(FIELD_SELECTOR).elementHandles();
  const results: DetectedField[] = [];
  const seen = new Set<string>();

  for (const handle of handles) {
    const invalid = await handle.evaluate(isInvalid).catch(() => false);
    if (!invalid) continue;

    const label = await handle.evaluate(extractLabel).catch(() => '');
    if (!label || KNOWN_FIELD_LABEL_EXCLUDE.test(label)) continue;

    const normalized = normalizeLabel(label);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const tag = await handle.evaluate((el) => el.tagName.toLowerCase());
    const type = await handle.evaluate((el) => el.type || '');
    if (type === 'password') continue;

    let fieldType: DetectedField['fieldType'] = 'text';
    let options: string[] = [];
    if (tag === 'textarea') fieldType = 'textarea';
    else if (tag === 'select') {
      fieldType = 'select';
      options = await handle.evaluate((el) =>
        Array.from(el.options as any[]).map((o: any) => (o.textContent || '').trim()).filter(Boolean),
      );
    } else if (type === 'radio') fieldType = 'radio';
    else if (type === 'checkbox') fieldType = 'checkbox';

    results.push({ questionText: label, fieldType, options });
  }

  return results;
}

export { normalizeLabel };
