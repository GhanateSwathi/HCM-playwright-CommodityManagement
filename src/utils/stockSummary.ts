import { Page, expect } from '@playwright/test';

/**
 * Reads product balances off the dashboard's Stock Summary tab.
 *
 * The state user ships from a real warehouse rather than from a supplier, so
 * the quantity written into the template is bounded by what that warehouse
 * actually holds. Hardcoding 200 the way the supplier flow does would make the
 * test pass or fail according to stock levels on the day.
 *
 * Each product renders as a card reading, in order:
 *
 *   SP - SPAQ 1   Total Received 0   Total Issued 86,250
 *                 Total Rejected 0   Total Returned 0   Balance -86,250
 *
 * The cards carry no roles or ids to anchor on, so the balance is pulled out of
 * the rendered text. That is deliberately narrow - the product name, then the
 * first `Balance` within a few hundred characters of it - and it throws rather
 * than guessing if the shape changes.
 */

/** Balance can legitimately be negative; see readStockBalances. */
export type Balances = Map<string, number>;

/** Every figure on a product's card, so the balance can be cross-checked. */
interface Card {
  received: number;
  issued: number;
  rejected: number;
  returned: number;
  balance: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

/**
 * Pulls one product's whole card out of the page text.
 *
 * Reads all five figures rather than just the balance so they can be checked
 * against each other. An earlier version matched `Balance` alone and was
 * non-deterministic across runs - it once returned a positive number for a
 * warehouse whose real balance was -86,250, which would have shipped stock
 * that does not exist. The arithmetic check below is what makes a mis-match
 * fail loudly instead of silently returning a plausible wrong number.
 */
function parseCard(text: string, product: string): Card | null {
  const match = text.match(
    new RegExp(
      `${escapeRegExp(product)}[\\s\\S]{0,120}?` +
        `Total Received\\s*(-?[\\d,]+)[\\s\\S]{0,80}?` +
        `Total Issued\\s*(-?[\\d,]+)[\\s\\S]{0,80}?` +
        `Total Rejected\\s*(-?[\\d,]+)[\\s\\S]{0,80}?` +
        `Total Returned\\s*(-?[\\d,]+)[\\s\\S]{0,80}?` +
        `Balance\\s*(-?[\\d,]+)`,
    ),
  );
  if (!match) return null;

  return {
    received: toNumber(match[1]),
    issued: toNumber(match[2]),
    rejected: toNumber(match[3]),
    returned: toNumber(match[4]),
    balance: toNumber(match[5]),
  };
}

/**
 * The identity the figures should satisfy, used to catch a bad match.
 *
 * Note that Rejected is NOT subtracted. That is the app's arithmetic, not a
 * guess: a per-facility row reading 300 received, 60 issued, 15 rejected,
 * 0 returned reports a balance of 240, and 300 - 60 + 0 = 240. An earlier
 * version of this function also subtracted Rejected, which happened to agree
 * on every card where Rejected was 0 and would have wrongly discarded any row
 * where it was not.
 */
function isSelfConsistent(card: Card): boolean {
  return card.balance === card.received - card.issued + card.returned;
}

/**
 * Whether a card's figures are possible for real, settled data.
 *
 * `Total Received 0` alongside a non-zero `Total Issued` cannot be true of a
 * warehouse that has finished loading: stock cannot be issued that was never
 * received. It is exactly the shape the cards take mid-load, when Issued has
 * arrived and Received has not, and it is self-consistent by the identity
 * above - so stability and arithmetic checks alone both wave it through.
 *
 * Treating it as "still loading" is what stops the reader believing a balance
 * of -86,250 for a warehouse that actually holds 169,200.
 */
function looksSettled(card: Card): boolean {
  return !(card.received === 0 && card.issued > 0);
}

/**
 * Opens the Stock Summary tab and returns the balance for each named product.
 *
 * @param products e.g. `['SP - SPAQ 1', 'SP - SPAQ 2']`
 */
export async function readStockBalances(
  page: Page,
  products: string[],
): Promise<Balances> {
  /**
   * "Stock Summary" is the text of FOUR separate things once this tab is open:
   * the top-level tab, both card headings (`cm-summary-title`), and a second
   * tab beside Transaction List. A loose `getByText(...).first()` is therefore
   * ambiguous, and picking a card heading silently clicks nothing - leaving
   * whatever view was already showing and returning its figures instead. That
   * is what made this reader return two different self-consistent answers on
   * consecutive runs.
   *
   * Both tab rows share the same classes, so the row's own text is the only
   * reliable discriminator.
   */
  const topTabRow = page
    .locator('.digit-dss-switch-tab-wrapper')
    .filter({ hasText: /^Transaction Summary/ });

  const tab = topTabRow.getByText('Stock Summary', { exact: true });
  await expect(tab).toBeVisible({ timeout: 60_000 });

  /**
   * Sit on Transaction Summary for a minute before switching.
   *
   * The dashboard starts its aggregate queries when it loads, and switching
   * tabs straight away appears to race them - the Stock Summary cards then
   * render with "Total Received" missing and a negative balance derived from
   * the half of the data that did arrive. Letting the page finish on the tab
   * it opens on first gives those queries time to land.
   */
  await page.waitForTimeout(60_000);

  await tab.click();

  /** One complete, self-consistent read of every requested product, or null. */
  async function readAll(): Promise<Map<string, Card> | null> {
    const text = await page.locator('body').innerText();
    const cards = new Map<string, Card>();

    for (const product of products) {
      const card = parseCard(text, product);
      if (!card) return null;
      if (!isSelfConsistent(card)) {
        // A card that does not add up means the regex latched onto figures
        // from more than one card - never trust the number in that case.
        return null;
      }
      if (!looksSettled(card)) {
        // Issued without ever having received: the card is still filling in.
        return null;
      }
      cards.set(product, card);
    }
    return cards;
  }

  /**
   * The cards do not populate atomically. A partly-loaded card is still
   * internally consistent - Received 0 with Issued 86,250 reports a balance of
   * -86,250, and 0 - 86,250 + 0 really is -86,250 - so the arithmetic check
   * above cannot tell a half-loaded card from a settled one. Observed against
   * Bauchi: the same page read -86,250 mid-load and +169,200 once Received had
   * arrived, alternating between runs.
   *
   * That intermediate value is the dangerous one, because it reads as "no
   * stock available" and would silently skip every shipment.
   *
   * So the figures must hold steady across several reads spaced well apart. A
   * still-loading card changes and resets the streak; a settled one does not.
   * This is strictly better than one long sleep, which would only be a slower
   * guess at how long the slowest query takes.
   */
  const REQUIRED_STABLE_READS = 3;
  const GAP_MS = 3_000;
  /** How long to let one page state try before reloading to re-trigger it. */
  const ATTEMPT_MS = 90_000;
  const ATTEMPTS = 4;

  let stable: Map<string, Card> | null = null;

  for (let attempt = 1; attempt <= ATTEMPTS && !stable; attempt++) {
    const deadline = Date.now() + ATTEMPT_MS;
    let streak = 0;
    let previous: Map<string, Card> | null = null;

    while (Date.now() < deadline) {
      const current = await readAll();

      if (!current) {
        // Unparseable, or still showing the impossible "issued but never
        // received" shape. Reset and keep watching.
        streak = 0;
        previous = null;
        await page.waitForTimeout(GAP_MS);
        continue;
      }

      if (
        previous &&
        products.every(
          (p) => previous!.get(p)!.balance === current.get(p)!.balance,
        )
      ) {
        streak += 1;
      } else {
        streak = 1;
      }

      previous = current;

      if (streak >= REQUIRED_STABLE_READS) {
        stable = current;
        break;
      }
      await page.waitForTimeout(GAP_MS);
    }

    if (stable) break;

    // The cards can sit half-loaded indefinitely - observed stuck at
    // "Received 0" for a full three minutes. Waiting longer does not shift it,
    // so reload to re-issue the queries behind them, then re-open the tab.
    if (attempt < ATTEMPTS) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const tabAgain = page
        .locator('.digit-dss-switch-tab-wrapper')
        .filter({ hasText: /^Transaction Summary/ })
        .getByText('Stock Summary', { exact: true });
      await expect(tabAgain).toBeVisible({ timeout: 120_000 });

      // Same pause as on first load - a reload restarts those queries, so
      // switching tabs immediately would race them exactly as before.
      await page.waitForTimeout(60_000);
      await tabAgain.click();
    }
  }

  if (!stable) {
    throw new Error(
      `Stock Summary never settled for ${products.join(', ')} after ` +
        `${ATTEMPTS} attempts of ${ATTEMPT_MS / 1000}s, reloading between ` +
        `each. The cards stayed half-loaded - typically "Total Received 0" ` +
        `alongside a non-zero "Total Issued", which cannot be real settled ` +
        `data. Check the screenshot in artifacts/.`,
    );
  }

  const cards = stable as unknown as Map<string, Card>;
  const balances: Balances = new Map();
  for (const product of products) {
    balances.set(product, cards.get(product)!.balance);
  }

  // Put the dashboard back the way it was found. Reading the balances is meant
  // to be an observation, not a state change - and it is not: opening the
  // shipment dialog while Stock Summary is showing left the destination
  // facility list unrendered in two runs out of three.
  await topTabRow.getByText('Transaction Summary', { exact: true }).click();
  await expect(
    page.getByText('Transaction List', { exact: true }).first(),
  ).toBeVisible({ timeout: 60_000 });

  return balances;
}

/**
 * The quantity it is safe to ship: the smaller of what we want and what is
 * there, never below zero.
 *
 * A negative balance yields 0, which callers should treat as "do not ship"
 * rather than as a quantity - shipping zero of something would create a
 * pointless record.
 */
export function shippableQuantity(desired: number, balance: number): number {
  if (!Number.isInteger(desired) || desired < 0) {
    throw new Error(`desired must be a whole number of 0 or greater, got ${desired}`);
  }
  return Math.max(0, Math.min(desired, balance));
}
