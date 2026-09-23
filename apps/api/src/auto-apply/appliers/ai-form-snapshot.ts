import type { Page, Locator } from 'playwright';
import type { ApplyContext } from './applier.interface';
import { KNOWN_FIELD_LABEL_EXCLUDE, numericFromAnswer } from './form-fields';
import { humanFill, humanClick } from './ats-common';

// The functions passed to page.evaluate() below run inside the browser, not
// in Node — this project's tsconfig has no DOM lib, so `document` is
// declared locally rather than pulling DOM types into the whole backend.
declare const document: any;

export interface SnapshotField {
  // A plain text/textarea/select/checkbox field has its own idx. A
  // radio-group has no idx of its own — the idx to act on lives on each of
  // its options instead, since "answering" a radio group means clicking one
  // specific option element.
  idx?: number;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'checkbox' | 'radio-group';
  options?: string[]; // select: option labels
  radioOptions?: { idx: number; text: string }[]; // radio-group only
}

export interface SnapshotButton {
  idx: number;
  text: string;
}

export interface FormSnapshot {
  fields: SnapshotField[];
  buttons: SnapshotButton[];
  // The form's real markup, pruned, with a data-ai-idx on every interactive
  // element. `fields` above is built from label heuristics (label[for], a
  // wrapping <label>, aria-label, <legend>, previous sibling) and a field
  // none of them reach never reaches the model at all — confirmed live on
  // aplitrak.com, whose required "Nom" input puts its label in a neighbouring
  // table cell: it was absent from the prompt, so the AI could not fill what
  // it was never told existed, and the candidature failed on an empty field.
  // The markup carries what the heuristics miss, including which of several
  // forms on the page is the application one.
  markup: string;
}

const MAX_FIELDS = 25;
const MAX_BUTTONS = 12;
const MAX_LABEL_LEN = 100;
// ~12k characters of pruned markup is roughly 3-4k tokens: enough for a real
// application form (the ones seen live sit well under it once scripts,
// styles and layout wrappers are gone) without ever approaching the cost of
// shipping a whole raw page.
const MAX_MARKUP_CHARS = 12000;

// Walks the currently-visible form, tagging every actionable element with a
// stable `data-ai-idx` attribute (reused across calls for elements already
// tagged) so a later action can address the exact element by attribute
// selector instead of needing to reconstruct a CSS/XPath selector for
// arbitrary, unknown markup — this is what makes the same code work across
// any platform's HTML, not just the ones with hand-written selectors.
// Already-filled fields and fields the dedicated identity/known-answer
// filling already owns (name/email/phone/CV/cover letter) are excluded, so
// only genuinely unresolved fields ever reach the model.
export async function buildFormSnapshot(page: Page): Promise<FormSnapshot> {
  try {
    return await buildFormSnapshotOnce(page);
  } catch (error: any) {
    // Confirmed live via a real stack trace on a Cegedim career-site retry:
    // a click just before this (the reveal-button click in
    // generic.applier.ts, only followed by a fixed 1000ms wait) can still
    // be navigating when this runs, tearing down the very execution
    // context page.evaluate() is running in. Retrying once after letting
    // the page settle handles this without needing every single call site
    // upstream to guess the right fixed delay for a redirect whose timing
    // varies per site.
    if (!/execution context was destroyed/i.test(error?.message || '')) throw error;
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return buildFormSnapshotOnce(page);
  }
}

// One shared notion of "the region we are applying in", used by the AI
// snapshot AND by the deterministic fillers/scanners, so they all act on the
// same form instead of each other's. Deliberately generic: an open modal, a
// form carrying a CV upload, otherwise the common ancestor of the
// interactive elements, otherwise the page itself — no site-specific
// selector, and a page with a single plain form resolves to the same thing
// it always did.
export async function markPreExistingFields(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const doc: any = document;
      doc.querySelectorAll('input, textarea, select').forEach((el: any) => el.setAttribute('data-ai-pre', '1'));
    })
    .catch(() => {});
}

// Waits for at least one interactive element that markPreExistingFields did
// not mark, i.e. one the reveal click actually brought in.
export async function waitForRevealedFields(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page
      .evaluate(() => {
        const doc: any = document;
        const els = Array.from(doc.querySelectorAll('input:not([type=hidden]), textarea, select')) as any[];
        return els.some((el: any) => {
          if (el.hasAttribute('data-ai-pre') || el.disabled) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      })
      .catch(() => false);
    if (found) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

export async function markApplicationRoot(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const doc: any = document;
      const isVisible = (el: any) => {
        if (!el || (!el.offsetParent && !(el.getClientRects && el.getClientRects().length))) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      doc.querySelectorAll('[data-ai-root]').forEach((el: any) => el.removeAttribute('data-ai-root'));

      const interactive = Array.from(
        doc.querySelectorAll('input:not([type=hidden]), textarea, select'),
      ).filter((el: any) => isVisible(el) && !el.disabled) as any[];
      if (!interactive.length) return;

      let root: any = null;

      // Fields that appeared only after the "Postuler" click (see
      // markPreExistingFields) are the application form, whatever the site's
      // markup looks like. Preferred over any class- or role-based guess.
      const fresh = interactive.filter((el: any) => !el.hasAttribute('data-ai-pre'));
      if (fresh.length) {
        let candidate = fresh[0].parentElement;
        while (candidate && candidate !== doc.body) {
          if (fresh.every((el: any) => candidate.contains(el))) break;
          candidate = candidate.parentElement;
        }
        if (candidate && candidate !== doc.body) root = candidate;
      }

      const dialogs = !root
        ? (Array.from(doc.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, .fancybox-container')) as any[])
            .filter((d) => isVisible(d) && interactive.some((el: any) => d.contains(el)))
        : [];
      if (dialogs.length) root = dialogs.reduce((best: any, d: any) => (best && best.contains(d) ? d : best || d), null);

      if (!root) {
        root = (Array.from(doc.querySelectorAll('form')) as any[]).find(
          (f) => isVisible(f) && f.querySelector('input[type="file"]'),
        );
      }

      if (!root) {
        let candidate = interactive[0].parentElement;
        while (candidate && candidate !== doc.body) {
          if (interactive.every((el: any) => candidate.contains(el))) break;
          candidate = candidate.parentElement;
        }
        root = candidate;
      }

      if (root && root !== doc.body) root.setAttribute('data-ai-root', '1');
    })
    .catch(() => {});
}

// The scope everything should work in. Falls back to the whole page whenever
// no region could be identified, which keeps every already-working site on
// exactly the behaviour it had.
export async function applicationScope(page: Page): Promise<Page | Locator> {
  const root = page.locator('[data-ai-root]').first();
  return (await root.count().catch(() => 0)) > 0 ? root : page;
}

function buildFormSnapshotOnce(page: Page): Promise<FormSnapshot> {
  return page.evaluate(
    ({ excludeSource, excludeFlags, maxFields, maxButtons, maxLabelLen, maxMarkupChars }) => {
      const doc: any = document;
      const excludeRe = new RegExp(excludeSource, excludeFlags);

      const existingIdxs = Array.from(doc.querySelectorAll('[data-ai-idx]')).map(
        (e: any) => Number(e.getAttribute('data-ai-idx')) || 0,
      );
      let counter = existingIdxs.length ? Math.max(...existingIdxs) + 1 : 1;

      const tag = (el: any): number => {
        const existing = el.getAttribute('data-ai-idx');
        if (existing) return Number(existing);
        const idx = counter++;
        el.setAttribute('data-ai-idx', String(idx));
        return idx;
      };

      // Confirmed live on HelloWork, with an actual captured DOM chain: a
      // collapsed "Personnaliser mon message au recruteur" accordion panel
      // (Tailwind's `max-h-0 overflow-hidden` pattern) clips its content to
      // nothing via the WRAPPING div (clientHeight 0, maxHeight "0px",
      // overflow "hidden") -- but the textarea INSIDE it still reports its
      // own full intrinsic size (h:24) via getBoundingClientRect, since CSS
      // clipping on an ancestor doesn't change a descendant's own measured
      // box. Neither offsetParent/getClientRects nor the element's own rect
      // alone can tell this apart from a genuinely visible field; only
      // walking up and checking whether an ancestor is actually clipping it
      // to zero can.
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
      const truncate = (s: string) => (s || '').trim().replace(/\s+/g, ' ').slice(0, maxLabelLen);

      const extractLabel = (el: any): string => {
        const id = el.getAttribute('id');
        if (id) {
          const escaped = (doc.defaultView?.CSS || (globalThis as any).CSS)?.escape
            ? (doc.defaultView?.CSS || (globalThis as any).CSS).escape(id)
            : id;
          const lbl = doc.querySelector(`label[for="${escaped}"]`);
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

      const fields: SnapshotField[] = [];

      // Radios first, grouped by `name` — one field entry per group with an
      // idx per option, so the model answers "which option" rather than
      // needing to understand a whole group as one unit.
      const radios = Array.from(doc.querySelectorAll('input[type="radio"]')) as any[];
      const groups = new Map<string, any[]>();
      for (const el of radios) {
        if (!isVisible(el) || el.disabled) continue;
        const key = el.name || `__ungrouped_${groups.size}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(el);
      }
      for (const options of groups.values()) {
        if (fields.length >= maxFields) break;
        if (options.some((o: any) => o.checked)) continue; // already answered

        const first = options[0];
        const fieldset = first.closest('fieldset');
        const legend = fieldset?.querySelector('legend');
        let groupLabel = legend?.textContent?.trim() || '';
        if (!groupLabel) {
          let current = first;
          for (let i = 0; i < 4; i++) {
            if (!current || current === doc.body) break;
            const ariaLabelledby = current.getAttribute('aria-labelledby');
            if (ariaLabelledby) {
              const lbl = doc.getElementById(ariaLabelledby);
              if (lbl && lbl.textContent?.trim()) { groupLabel = lbl.textContent.trim(); break; }
            }
            if (current.getAttribute('role') === 'group' && current.getAttribute('aria-label')) {
              groupLabel = current.getAttribute('aria-label').trim(); break;
            }
            current = current.parentElement;
          }
        }
        if (!groupLabel) {
          let current = first.parentElement;
          for (let i = 0; i < 4; i++) {
            if (!current || current === doc.body || groupLabel) break;
            let prev = current.previousElementSibling;
            while (prev && !groupLabel) {
              const text = prev.textContent?.trim();
              if (text && text.length > 2) groupLabel = text;
              prev = prev.previousElementSibling;
            }
            current = current.parentElement;
          }
        }
        if (excludeRe.test(groupLabel)) continue;

        const radioOptions = options.map((r: any) => ({
          idx: tag(r),
          text: truncate(extractLabel(r) || r.value || ''),
        }));
        fields.push({ label: truncate(groupLabel || '(choix)'), kind: 'radio-group', radioOptions });
      }

      // Everything else: text/textarea/select/checkbox.
      const candidates = Array.from(
        doc.querySelectorAll(
          'input:not([type=file]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=password]):not([type=radio]), textarea, select',
        ),
      ) as any[];

      for (const el of candidates) {
        if (fields.length >= maxFields) break;
        if (!isVisible(el) || el.disabled) continue;

        const type = (el.type || '').toLowerCase();
        const tagName = el.tagName.toLowerCase();

        if (type === 'checkbox') {
          if (el.checked) continue;
          // Confirmed live on a Viveris career-site apply-time screenshot:
          // two mandatory GDPR-consent checkboxes were left unchecked and
          // blocked submission with a "Ce champ est obligatoire" error — but
          // neither had a real `required`/`aria-required` attribute, since
          // the site enforces them via its own JS validation instead of
          // native HTML5 validation. Widening the required-detection regex
          // alone didn't fix it: extractLabel() came back EMPTY for this
          // exact checkbox (no id/for, no wrapping <label>, no aria-label,
          // no previous-sibling text — its long consent paragraph sits
          // beside it in the DOM in a way none of those heuristics reach),
          // so the regex was being tested against '' and could never match.
          // Falls back to the checkbox's whole containing block's text for
          // the consent-wording check specifically — broader than a real
          // label, but only ever used to decide "is this mandatory", not
          // shown verbatim (the field's own `truncate()` caps it either way
          // for the model, and a genuinely optional checkbox's surrounding
          // text — newsletters, marketing opt-ins — doesn't use this kind of
          // wording, so this doesn't risk opting into those).
          let label = extractLabel(el);
          const consentContext = label || el.closest('div, li, tr, fieldset')?.textContent || '';
          const required =
            el.required ||
            el.getAttribute('aria-required') === 'true' ||
            /obligatoire|vous êtes tenu|en cochant cette case|j'accepte|je certifie|conditions générales|politique de confidentialité|traitement de mes données|required|you must agree|i agree/i.test(
              consentContext,
            );
          if (!required) continue; // optional checkboxes (newsletters, etc.) are never worth asking about
          if (!label) label = consentContext;
          if (!label || excludeRe.test(label)) continue;
          fields.push({ idx: tag(el), label: truncate(label), kind: 'checkbox' });
          continue;
        }

        const value = (el.value || '').trim();
        // Confirmed live on a Direct Emploi form: "Niveau de formation" sat on
        // its default "Aucune formation" option, which carries a non-empty
        // value, so it counted as "already filled" and was never asked --
        // the form then rejected it. A select whose selected option reads
        // like a placeholder (or is its first, blank-valued option) is
        // unanswered whatever its value attribute says.
        const placeholderRe = /^(--|—|\.\.\.|)$|choisir|choisissez|s[ée]lectionn|aucun|veuillez|select|choose|please|^--/i;
        const selectedText = tagName === 'select' ? (el.options?.[el.selectedIndex]?.textContent || '').trim() : '';
        const selectUnanswered =
          tagName === 'select' && (!value || placeholderRe.test(selectedText) || (el.selectedIndex === 0 && !el.options?.[0]?.value));
        if (value && !selectUnanswered) continue; // already filled — don't re-ask

        const label = extractLabel(el);
        if (!label || excludeRe.test(label)) continue;

        if (tagName === 'select') {
          // Same Direct Emploi form: "Métier" has ~60 options and the model
          // only ever saw the first 8 -- none of them "Développeur", so it
          // either guessed one of those 8 ("Banque / Assurance" for a
          // developer) or answered something selectOption() couldn't match.
          // Real option lists are sent up to 60 entries; beyond that,
          // entries that look relevant to a tech candidate are kept first.
          const allOptions = Array.from(el.options || [])
            .map((o: any) => (o.textContent || '').trim())
            .filter((t: string) => t && !placeholderRe.test(t));
          const MAX_OPTIONS = 60;
          let options = allOptions;
          if (allOptions.length > MAX_OPTIONS) {
            const relevant = /informati|d[ée]velop|logiciel|software|web|digital|num[ée]ri|\bit\b|ing[ée]nieur|tech|data|syst[èe]me|r[ée]seau|bac|master|licence|dipl|ann[ée]e/i;
            const preferred = allOptions.filter((t: string) => relevant.test(t));
            const rest = allOptions.filter((t: string) => !relevant.test(t));
            options = [...preferred, ...rest].slice(0, MAX_OPTIONS);
          }
          fields.push({ idx: tag(el), label: truncate(label), kind: 'select', options });
        } else if (tagName === 'textarea') {
          fields.push({ idx: tag(el), label: truncate(label), kind: 'textarea' });
        } else {
          fields.push({ idx: tag(el), label: truncate(label), kind: 'text' });
        }
      }

      const buttons: SnapshotButton[] = [];
      const buttonCandidates = Array.from(
        doc.querySelectorAll('button, input[type="submit"], a[role="button"]'),
      ) as any[];
      for (const el of buttonCandidates) {
        if (buttons.length >= maxButtons) break;
        if (!isVisible(el) || el.disabled) continue;
        const text = truncate(el.innerText || el.value || el.getAttribute('aria-label') || '');
        if (!text) continue;
        buttons.push({ idx: tag(el), text });
      }

      // Every visible interactive element gets an idx, including the ones no
      // label heuristic could describe — those are precisely the ones the
      // model can only act on through the markup below.
      const interactive = Array.from(
        doc.querySelectorAll('input:not([type=hidden]), textarea, select, button, [role="button"]'),
      ) as any[];
      for (const el of interactive) {
        if (isVisible(el) && !el.disabled) tag(el);
      }

      // Which region is the application form. Confirmed live on
      // alphea-conseil.com: the page also carries a contact sidebar ("Votre
      // nom / Votre email / Votre message") and a lead popup, whose labels
      // are near-identical to the real form's — shipping the whole body let
      // the model fill and submit the sidebar while the actual modal's
      // "Ville" stayed empty. An open modal wins; otherwise the <form> that
      // carries the CV upload does; otherwise fall back to the whole page.
      const tagged = Array.from(doc.querySelectorAll('[data-ai-idx]')) as any[];
      let root: any = null;

      const marked = doc.querySelector('[data-ai-root]');
      if (marked) root = marked;

      const dialogs = !root
        ? (Array.from(doc.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, .fancybox-container')) as any[])
            .filter((d) => isVisible(d) && d.querySelector('[data-ai-idx]'))
        : [];
      if (dialogs.length) {
        // The innermost visible dialog: a modal nested in a wrapper should
        // not drag the wrapper's siblings back in.
        root = dialogs.reduce((best: any, d: any) => (best && best.contains(d) ? d : best || d), null);
      }

      if (!root) {
        const formWithUpload = (Array.from(doc.querySelectorAll('form')) as any[]).find(
          (f) => isVisible(f) && f.querySelector('input[type="file"]'),
        );
        if (formWithUpload) root = formWithUpload;
      }

      if (!root && tagged.length) {
        let candidate = tagged[0].parentElement;
        while (candidate && candidate !== doc.body) {
          if (tagged.every((el: any) => candidate.contains(el))) break;
          candidate = candidate.parentElement;
        }
        root = candidate;
      }
      root = root || doc.body;

      const KEEP_ATTRS = [
        'data-ai-idx', 'type', 'name', 'id', 'for', 'placeholder', 'value',
        'required', 'aria-required', 'aria-label', 'checked', 'selected', 'maxlength', 'role', 'alt', 'title',
      ];
      const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'SVG', 'IFRAME', 'NOSCRIPT', 'LINK', 'META', 'PATH', 'PICTURE', 'VIDEO', 'CANVAS']);

      const serialize = (el: any, depth: number): string => {
        if (depth > 14) return '';
        if (DROP_TAGS.has(el.tagName)) return '';
        if (!isVisible(el) && !el.querySelector?.('[data-ai-idx]')) return '';

        const name = el.tagName.toLowerCase();
        let attrs = '';
        for (const a of KEEP_ATTRS) {
          const v = el.getAttribute?.(a);
          if (v !== null && v !== undefined && v !== '') attrs += ` ${a}="${String(v).slice(0, 120).replace(/"/g, "'")}"`;
        }
        if (el.checked) attrs += ' checked';

        let inner = '';
        for (const node of Array.from(el.childNodes) as any[]) {
          if (node.nodeType === 3) {
            const text = (node.textContent || '').replace(/\s+/g, ' ');
            if (text.trim()) inner += text;
          } else if (node.nodeType === 1) {
            inner += serialize(node, depth + 1);
          }
        }
        // A wrapper that adds neither an attribute nor an element of its own
        // is layout noise; keep its content, drop the tag.
        if (!attrs && !/^(input|textarea|select|button|option|label|legend|td|th|tr|li)$/.test(name)) return inner;
        return `<${name}${attrs}>${inner}</${name}>`;
      };

      const markup = serialize(root, 0).replace(/\s+/g, ' ').slice(0, maxMarkupChars);

      return { fields, buttons, markup };
    },
    {
      excludeSource: KNOWN_FIELD_LABEL_EXCLUDE.source,
      excludeFlags: KNOWN_FIELD_LABEL_EXCLUDE.flags,
      maxFields: MAX_FIELDS,
      maxButtons: MAX_BUTTONS,
      maxLabelLen: MAX_LABEL_LEN,
      maxMarkupChars: MAX_MARKUP_CHARS,
    },
  );
}

export interface FormStepPlan {
  fields: { idx: number; value: string }[];
  action: { idx: number | null; kind: 'submit' | 'next' | 'review' | 'stop' };
}

// Executes a plan produced from a FormSnapshot. Every idx is looked up by
// its `data-ai-idx` attribute — any idx the model hallucinated (not present
// in the snapshot it was actually given) simply matches nothing and is
// skipped rather than throwing, since a single bad reference should never
// A typeahead "select" (Select2, react-select, Choices.js, Taleez's own):
// an <input role=combobox> whose options only exist in a listbox once you
// type. Confirmed live on a Taleez form ("Votre expérience": typing left
// the text in the search box, "Aucun résultat", and the field still
// invalid). After typing, the matching option has to be picked -- the
// closest visible one, or Enter as a last resort.
async function pickComboboxOption(page: Page, el: Locator, value: string): Promise<void> {
  const isCombobox = await el
    .evaluate((e: any) => {
      const role = (e.getAttribute('role') || '').toLowerCase();
      const auto = (e.getAttribute('aria-autocomplete') || '').toLowerCase();
      const cls = `${e.className || ''} ${e.parentElement?.className || ''} ${e.closest('[class*="select" i], [class*="combobox" i], [class*="autocomplete" i]')?.className || ''}`;
      return role === 'combobox' || auto === 'list' || auto === 'both' || /select2|react-select|choices|autocomplete|combobox|typeahead|selectize/i.test(cls);
    })
    .catch(() => false);
  if (!isCombobox) return;
  await page.waitForTimeout(700);
  const wanted = (value || '').trim().toLowerCase();
  const options = page.locator('[role="option"], .select2-results__option, [class*="option" i]:not([class*="options" i]), li[id*="option" i], .dropdown-location, [class*="suggestion" i] li, [class*="autocomplete" i] li');
  const count = await options.count().catch(() => 0);
  let best: Locator | null = null;
  let firstVisible: Locator | null = null;
  for (let i = 0; i < Math.min(count, 40); i++) {
    const opt = options.nth(i);
    if (!(await opt.isVisible().catch(() => false))) continue;
    const text = (await opt.innerText().catch(() => '')).trim().toLowerCase();
    if (!text || /aucun r[ée]sultat|no results|no options/i.test(text)) continue;
    if (!firstVisible) firstVisible = opt;
    if (text === wanted || text.includes(wanted) || wanted.includes(text)) {
      best = opt;
      break;
    }
  }
  const pick = best || firstVisible;
  if (pick) {
    await humanClick(page, pick).catch(() => pick.click().catch(() => {}));
  } else {
    // No suggestion to take: close whatever the widget opened and leave
    // the typed text. (Enter here used to commit garbage on tag-style
    // inputs and could submit the form.)
    await el.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(300);
  // Confirmed live on a Workable address box ("Paris, France, F, Fr, Fra,
  // Fran, Franc, France"): an autocomplete that commits every partial
  // keystroke leaves the field worse than empty. The field must end up
  // holding the intended value, or a suggestion that starts with it.
  const finalValue = (await el.inputValue({ timeout: 1000 }).catch(() => '')) || '';
  const lowered = finalValue.toLowerCase();
  if (finalValue && lowered !== wanted && !lowered.startsWith(wanted) && !(pick && lowered.includes(wanted.split(',')[0].trim()))) {
    await el.fill(value).catch(() => {});
    await el.press('Escape').catch(() => {});
  }
}

// abort an otherwise-good plan.
export async function applyFormPlan(page: Page, plan: FormStepPlan): Promise<void> {
  for (const f of plan.fields || []) {
    if (typeof f?.idx !== 'number') continue;
    const el = page.locator(`[data-ai-idx="${f.idx}"]`).first();
    if ((await el.count().catch(() => 0)) === 0) continue;

    const tagName = await el.evaluate((e: any) => e.tagName.toLowerCase()).catch(() => '');
    const type = await el.evaluate((e: any) => (e.type || '').toLowerCase()).catch(() => '');

    if (type === 'radio') {
      await el.evaluate((e: any) => e.click()).catch(() => {});
    } else if (type === 'checkbox') {
      if (/^(true|yes|oui|1)$/i.test(f.value || 'true')) {
        await el
          .evaluate((e: any) => {
            if (!e.checked) e.click();
          })
          .catch(() => {});
      }
    } else if (tagName === 'select') {
      // Exact label, then value, then the closest option text -- the model
      // routinely answers "Informatique" for an option that reads
      // "Informatique / Télécoms", or drops an accent, and a strict match
      // silently left the select on its placeholder.
      const wanted = (f.value || '').trim();
      const selected = await el
        .selectOption({ label: wanted })
        .catch(() => el.selectOption(wanted).catch(() => [] as string[]));
      if (!selected.length && wanted) {
        await el
          .evaluate((e: any, want: string) => {
            const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
            const w = norm(want);
            const opts = Array.from(e.options || []) as any[];
            const scored = opts
              .map((o) => ({ o, t: norm(o.textContent || '') }))
              .filter(({ t }) => t)
              .map(({ o, t }) => ({ o, score: t === w ? 3 : t.includes(w) || w.includes(t) ? 2 : w.split(' ').some((word) => word.length > 3 && t.includes(word)) ? 1 : 0 }))
              .sort((a, b) => b.score - a.score);
            if (scored[0]?.score > 0) {
              e.value = scored[0].o.value;
              e.dispatchEvent(new Event('input', { bubbles: true }));
              e.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, wanted)
          .catch(() => {});
      }
    } else {
      // A URL field only ever accepts a URL. Confirmed live on a real WTTJ
      // application: a required "X" (Twitter) profile field the candidate
      // has no value for got the model's best guess -- the candidate's
      // NAME -- which the form rejected ("Invalid URL"), blocking submit on
      // every retry. Left empty instead, it surfaces through the existing
      // blocked-field report as a real, answerable question rather than a
      // hallucinated value that can never validate.
      const value = (f.value || '').trim();
      const isUrlValue = /^https?:\/\//i.test(value);
      if (type === 'url' && !isUrlValue) continue;
      // Same guard for URL fields that are only URL fields by NAME: confirmed
      // live on a WTTJ form whose "X" (Twitter) input is a plain text box --
      // the candidate's name went in, "URL invalide", submit blocked.
      const looksLikeUrlField = await el
        .evaluate((e: any) => {
          // Each source tested on its own: WTTJ's "X" (Twitter) field has a
          // one-letter label, which a combined "label + name + id" string
          // never matched as ^x$ (confirmed live -- the name went in again).
          const parts = [e.labels?.[0]?.textContent, e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.name, e.id]
            .map((v: any) => (v || '').toString().trim())
            .filter(Boolean);
          const urlish = /\burl\b|https?:|twitter|linkedin|github|gitlab|portfolio|site web|website|\blien\b|\blink\b/i;
          return parts.some((p: string) => /^x$|^x \(twitter\)$/i.test(p) || urlish.test(p));
        })
        .catch(() => false);
      if (looksLikeUrlField && !isUrlValue) continue;
      if (type === 'number') {
        const numeric = numericFromAnswer(f.value);
        if (!numeric) continue;
        f.value = numeric;
      }
      await humanFill(el, f.value);
      await pickComboboxOption(page, el, f.value);
    }
  }

  if (plan.action?.idx != null) {
    const btn = page.locator(`[data-ai-idx="${plan.action.idx}"]`).first();
    if ((await btn.count().catch(() => 0)) > 0) {
      await humanClick(page, btn).catch(() => btn.evaluate((e: any) => e.click()).catch(() => {}));
    }
  }
}

// Compact, token-light textual rendering of the snapshot for the prompt —
// plain numbered lines instead of verbose JSON, since the field/button
// count can run into the dozens on a dense form.
export function formatFieldsForPrompt(fields: SnapshotField[]): string {
  if (!fields.length) return '(aucun champ à renseigner)';
  return fields
    .map((f) => {
      if (f.kind === 'radio-group') {
        const opts = (f.radioOptions || []).map((o) => `[${o.idx}]${o.text}`).join(' / ');
        return `- "${f.label}" (choix unique) : ${opts}`;
      }
      if (f.kind === 'select') {
        return `- [${f.idx}] "${f.label}" (liste déroulante) options: ${(f.options || []).join(' | ')}`;
      }
      if (f.kind === 'checkbox') {
        return `- [${f.idx}] "${f.label}" (case à cocher, requise)`;
      }
      return `- [${f.idx}] "${f.label}" (${f.kind === 'textarea' ? 'texte long' : 'texte'})`;
    })
    .join('\n');
}

export function formatButtonsForPrompt(buttons: SnapshotButton[]): string {
  if (!buttons.length) return '(aucun bouton détecté)';
  return buttons.map((b) => `[${b.idx}] "${b.text}"`).join('\n');
}

// Kept intentionally short (name/email/phone/CV are handled separately and
// never need to reach the model) — a smaller prompt costs fewer tokens on
// every single step of every single application.
//
// Includes a compact work-history block (role/company/period/bullets) --
// added after confirmed live that screening questions like "depuis combien
// d'annees utilisez-vous Node.js ?" always came back unanswered (the model
// correctly refusing to invent a number) when all it had was a skills list
// with no dates or role context to estimate from. The AI prompt itself
// (ai.service.ts) now explicitly allows a reasoned estimate for this kind of
// question, but it still needs enough of the actual CV to ground that
// estimate in — the skills list alone was never enough.
export function buildCandidateBrief(ctx: ApplyContext, formText?: string): string {
  const cv = ctx.cv as any;
  const skills = (cv.skillGroups || [])
    .flatMap((g: any) => g.items || [])
    .slice(0, 20)
    .join(', ');
  const summary = (cv.summary || '').slice(0, 300);
  const experiences = (cv.experiences || [])
    .slice(0, 5)
    .map((e: any) => {
      const bullets = (e.bullets || []).slice(0, 2).join('; ');
      return `${e.role || ''} @ ${e.company || ''} (${e.period || ''})${bullets ? ` — ${bullets}` : ''}`;
    })
    .join(' | ')
    .slice(0, 700);
  const projects = (cv.projects || [])
    .slice(0, 4)
    .map((p: any) => `${p.name || ''}: ${(p.bullets || []).slice(0, 2).join('; ')}`)
    .join(' | ')
    .slice(0, 500);
  const extraCtx = (cv.additionalContext || '').slice(0, 300);
  const links = (cv.links || []).map((l: any) => `${l.type || 'lien'}: ${l.url}`).join(', ');
  const brief = `Nom: ${cv.fullName || ''}, Civilité: Monsieur, Email: ${cv.email || ''}, Téléphone: ${cv.phone || ''}, Ville: ${cv.location || 'Ile-de-France, France'}. Titre: ${cv.headline || ''}. Droit de travailler en France: Oui. RQTH: Non. Disponibilité: Immédiate. Liens: ${links}. Compétences: ${skills}. Résumé: ${summary}. Parcours: ${experiences}${projects ? `. Projets phares: ${projects}` : ''}${extraCtx ? `. Contexte candidat: ${extraCtx}` : ''}`;
  
  let finalBrief = brief.slice(0, 2500);
  if (ctx.knownAnswers && ctx.knownAnswers.size > 0) {
    // Confirmed live: 109 stored answers were being joined in map order and
    // cut at 800 characters, so the model saw the first handful and nothing
    // else — questions already answered elsewhere came back as "unknown" and
    // were raised again. When the current form's text is available, the
    // answers are ranked by how much they actually overlap with it, so the
    // budget is spent on the ones this form is likely to ask.
    const entries = Array.from(ctx.knownAnswers.entries());
    const haystack = (formText || '').toLowerCase();
    const ranked = haystack
      ? entries
          .map((entry) => {
            const words = entry[0]
              .toLowerCase()
              .split(/[^a-z0-9àâäéèêëïîôöùûüç]+/i)
              .filter((w) => w.length > 3);
            const hits = words.filter((w) => haystack.includes(w)).length;
            return { entry, score: words.length ? hits / words.length : 0 };
          })
          .sort((a, b) => b.score - a.score)
          .map((r) => r.entry)
      : entries;

    const qaPairs = ranked
      .map(([q, a]) => `Q: ${q} -> R: ${a}`)
      .join(' | ')
      .slice(0, 2500);
    finalBrief += `\nRéponses précédentes enregistrées (réutilise-les telles quelles si la question correspond): ${qaPairs}`;
  }

  return finalBrief;
}
