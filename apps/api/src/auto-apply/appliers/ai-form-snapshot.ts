import type { Page } from 'playwright';
import type { ApplyContext } from './applier.interface';
import { KNOWN_FIELD_LABEL_EXCLUDE } from './form-fields';

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
}

const MAX_FIELDS = 25;
const MAX_BUTTONS = 12;
const MAX_LABEL_LEN = 100;

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
  return page.evaluate(
    ({ excludeSource, excludeFlags, maxFields, maxButtons, maxLabelLen }) => {
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

      const isVisible = (el: any) => !!(el.offsetParent || (el.getClientRects && el.getClientRects().length));
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
          const container = fieldset || first.closest('div, li') || first.parentElement;
          let prev = container?.previousElementSibling;
          while (prev && !groupLabel) {
            groupLabel = prev.textContent?.trim() || '';
            prev = prev.previousElementSibling;
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
        if (value) continue; // already filled — don't re-ask

        const label = extractLabel(el);
        if (!label || excludeRe.test(label)) continue;

        if (tagName === 'select') {
          const options = Array.from(el.options || [])
            .map((o: any) => (o.textContent || '').trim())
            .filter(Boolean)
            .slice(0, 8);
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

      return { fields, buttons };
    },
    {
      excludeSource: KNOWN_FIELD_LABEL_EXCLUDE.source,
      excludeFlags: KNOWN_FIELD_LABEL_EXCLUDE.flags,
      maxFields: MAX_FIELDS,
      maxButtons: MAX_BUTTONS,
      maxLabelLen: MAX_LABEL_LEN,
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
      await el
        .selectOption({ label: f.value })
        .catch(() => el.selectOption(f.value).catch(() => {}));
    } else {
      await el.fill(f.value).catch(() => {});
    }
  }

  if (plan.action?.idx != null) {
    const btn = page.locator(`[data-ai-idx="${plan.action.idx}"]`).first();
    if ((await btn.count().catch(() => 0)) > 0) {
      await btn.click().catch(() => btn.evaluate((e: any) => e.click()).catch(() => {}));
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
export function buildCandidateBrief(ctx: ApplyContext): string {
  const cv = ctx.cv as any;
  const skills = (cv.skillGroups || [])
    .flatMap((g: any) => g.items || [])
    .slice(0, 12)
    .join(', ');
  const summary = (cv.summary || '').slice(0, 240);
  const brief = `${cv.fullName || ''} — ${cv.headline || ''}. Localisation: ${cv.location || ''}. Compétences: ${skills}. Résumé: ${summary}`;
  return brief.slice(0, 600);
}
