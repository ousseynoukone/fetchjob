import type { Locator } from 'playwright';

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
