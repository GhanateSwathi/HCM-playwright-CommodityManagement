import { Page, Locator } from '@playwright/test';

/**
 * Matches an element by `id` or by `aria-label`.
 *
 * The Maestro suite reported both of these as a single "resource-id", so the
 * selectors inherited from it are a mix: machine-looking ones like
 * `campaignName` really are `id` attributes, while human-readable ones like
 * "Landing page content" or "Select option: Bauchi" are `aria-label`s. Rather
 * than guess per selector, try both.
 *
 * Returns `.first()` because an element can legitimately carry the same value
 * in both attributes, which would otherwise trip Playwright's strict mode.
 */
export function byIdOrLabel(page: Page, value: string): Locator {
  const escaped = value.replace(/"/g, '\\"');
  return page.locator(`[id="${escaped}"], [aria-label="${escaped}"]`).first();
}
