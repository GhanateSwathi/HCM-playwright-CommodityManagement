import { test, expect } from '@playwright/test';
import path from 'path';
import { env, stateEnv } from '../src/utils/env';
import { LoginPage } from '../src/pages/LoginPage';
import { CommodityPage } from '../src/pages/CommodityPage';
import { StateBulkStockUploadPage } from '../src/pages/StateBulkStockUploadPage';
import { fillStockTemplate, readStockQuantities } from '../src/utils/stockTemplate';
import { readStockBalances, shippableQuantity } from '../src/utils/stockSummary';

/**
 * New Shipment as the STATE user - shipping out of a real warehouse.
 *
 *   login as the state user -> Commodity Management -> campaign dashboard
 *   -> read the SPAQ balances off Stock Summary
 *   -> New Shipment
 *   -> confirm the source warehouse the dialog pre-selected
 *   -> narrow LGA -> Ward -> Health Facility, then tick the facility
 *   -> download the stock template
 *   -> write quantities bounded by the balances
 *   -> upload
 *   -> Submit
 *   -> verify the Transaction List
 *
 * How this differs from new-shipment.spec.ts, which ships from a supplier:
 *
 *   - the source is a warehouse (State CMS) that the dialog pre-selects, so the
 *     spec asserts it rather than choosing it
 *   - the destination is three levels deep instead of one
 *   - **the quantity is not a constant.** A supplier is effectively an infinite
 *     source; a warehouse is not. The quantity written is
 *     min(HCM_SPAQn, balance), read from Stock Summary at run time, and the
 *     shipment is skipped outright if a balance is not positive. A hardcoded
 *     200 would pass or fail according to stock levels on the day.
 *
 * One test, so one login - same reasoning as the supplier spec.
 *
 * Submitting writes real records, gated on HCM_ALLOW_SUBMIT as everywhere else,
 * and additionally on there being stock to ship.
 */

const ARTIFACT_DIR = path.resolve(__dirname, '..', 'artifacts', 'state-new-shipment');

/** Stock Summary names these differently from the template's column headers. */
const SPAQ1_PRODUCT = 'SP - SPAQ 1';
const SPAQ2_PRODUCT = 'SP - SPAQ 2';

test.describe('Commodity Management - New Shipment (state user)', () => {
  // Longer than the 5 minutes the config allows every other spec. This one
  // waits for the Stock Summary figures to settle, then deliberately lets the
  // dashboard go quiet before opening the dialog, then may retry the boundary
  // fetch - none of which the supplier flow has to do. 15 rather than 12
  // minutes: selectHealthFacilityWithList retries up to 5 times at 60s each
  // (worst case 5 minutes) rather than 3, because a live run hit the boundary
  // fetch failing 3/3 in a row - see StateBulkStockUploadPage quirk #3.
  test.describe.configure({ timeout: 15 * 60 * 1000 });

  test('state user bulk stock upload: State CMS down to a health facility', async ({
    page,
  }) => {
    const login = new LoginPage(page);
    const commodity = new CommodityPage(page);
    const dialog = new StateBulkStockUploadPage(page);

    await test.step('sign in as the state user', async () => {
      await login.loginAndWait(stateEnv.userId, stateEnv.password);
    });

    await test.step('open the campaign dashboard', async () => {
      await commodity.openModule();
      await commodity.searchCampaign(env.campaignName);
      await commodity.openDashboard();
    });

    let spaq1 = 0;
    let spaq2 = 0;
    let balance1 = 0;
    let balance2 = 0;

    await test.step('read the SPAQ balances from Stock Summary', async () => {
      const balances = await readStockBalances(page, [
        SPAQ1_PRODUCT,
        SPAQ2_PRODUCT,
      ]);

      balance1 = balances.get(SPAQ1_PRODUCT)!;
      balance2 = balances.get(SPAQ2_PRODUCT)!;

      spaq1 = shippableQuantity(env.spaq1, balance1);
      spaq2 = shippableQuantity(env.spaq2, balance2);

      test.info().annotations.push({
        type: 'stock-balances',
        description:
          `${SPAQ1_PRODUCT}: balance ${balance1}, shipping ${spaq1}. ` +
          `${SPAQ2_PRODUCT}: balance ${balance2}, shipping ${spaq2}.`,
      });
    });

    await test.step('let the dashboard settle, then open Bulk Stock Upload', async () => {
      // Deliberate pause before opening the dialog. The balances above are only
      // believed once they have settled, but the dashboard keeps fetching after
      // that, and opening the shipment dialog into that traffic is when the
      // destination facility list is most likely to come back empty.
      await page.waitForLoadState('networkidle').catch(() => {
        // networkidle can never arrive on a page that polls; the fixed settle
        // below is the real guarantee, so a timeout here is not a failure.
      });
      await page.waitForTimeout(30_000);

      await commodity.openNewShipment();
      await expect(dialog.heading).toBeVisible();
    });

    await test.step('confirm the source warehouse', async () => {
      await dialog.expectSourceFacility(stateEnv.fromFacility);
    });

    await test.step('narrow to the destination facility', async () => {
      await dialog.selectLga(stateEnv.lga);
      await dialog.selectWard(stateEnv.ward);
      // Retries the Health Facility pick if the boundary fetch behind the
      // facility list comes back empty, which it does intermittently.
      await dialog.selectHealthFacilityWithList(
        stateEnv.toFacilityName,
        stateEnv.toFacility,
      );
    });

    let filledPath = '';

    await test.step('download and fill the stock template', async () => {
      const downloaded = await dialog.downloadTemplate(ARTIFACT_DIR);
      expect(downloaded).toMatch(/\.xlsx$/);

      const result = await fillStockTemplate(
        downloaded,
        spaq1,
        spaq2,
        path.join(ARTIFACT_DIR, 'Stock_Template_filled.xlsx'),
      );
      filledPath = result.filledPath;
      expect(result.rowsFilled).toBeGreaterThan(0);

      // Read back off disk rather than trusting the writer.
      const rows = await readStockQuantities(filledPath);
      expect(rows.length).toBe(result.rowsFilled);
      for (const row of rows) {
        expect(Number(row.spaq1)).toBe(spaq1);
        expect(Number(row.spaq2)).toBe(spaq2);
      }
    });

    await test.step('upload the filled template', async () => {
      await dialog.uploadTemplate(filledPath);
    });

    await test.step('submit the shipment', async () => {
      // Two independent gates. The stock one is not a safety switch but a
      // data-validity one: shipping more than a warehouse holds, or shipping
      // from a warehouse whose balance is already negative, would create
      // records that should not exist.
      const haveStock = spaq1 > 0 || spaq2 > 0;

      if (!haveStock) {
        test.info().annotations.push({
          type: 'skipped-step',
          description:
            `Submit skipped: no stock to ship. ${SPAQ1_PRODUCT} balance is ` +
            `${balance1} and ${SPAQ2_PRODUCT} is ${balance2}, so the quantity ` +
            `bounded by the balance is zero. Everything up to and including ` +
            `the upload ran, and Submit was verified enabled.`,
        });
        await expect(dialog.submitButton).toBeEnabled();
        return;
      }

      if (!env.allowSubmit) {
        test.info().annotations.push({
          type: 'skipped-step',
          description:
            'Submit skipped: HCM_ALLOW_SUBMIT is not "true". Everything up to ' +
            'and including the upload ran, and Submit was verified enabled.',
        });
        await expect(dialog.submitButton).toBeEnabled();
        return;
      }

      await dialog.submit();

      // The dialog closes on submit but the records are created afterwards by a
      // batch job. Asserting the dialog alone would pass at "0/2 processed",
      // going green even if every record then failed.
      await expect(dialog.heading).toBeHidden({ timeout: 120_000 });

      const progress = page.getByText(/\d+\/\d+ records processed/);

      await expect
        .poll(
          async () => {
            if ((await progress.count()) === 0) return 'batch-banner-gone';
            return (await progress.first().textContent())?.trim() ?? '';
          },
          {
            timeout: 180_000,
            message: 'the batch never finished processing',
          },
        )
        .toMatch(/^batch-banner-gone$|^(\d+)\/\1 records processed/);

      if ((await progress.count()) > 0) {
        await expect(progress.first()).toContainText('0 failed');
      }
    });

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, 'after-submit.png'),
      fullPage: true,
    });

    await test.step('verify the Transaction List', async () => {
      const transactionList = page.getByText('Transaction List', { exact: true });
      await expect(transactionList).toBeVisible({ timeout: 120_000 });

      for (const header of ['Sent from', 'Sent to', 'Commodity', 'Quantity', 'Status']) {
        await expect(
          page.getByText(header, { exact: true }).first(),
        ).toBeVisible();
      }

      // Live data - rows exist, never a specific count.
      const rows = page.getByText(stateEnv.fromFacility.replace(/\s*\(.*\)$/, ''), {
        exact: false,
      });
      await expect(rows.first()).toBeVisible({ timeout: 60_000 });

      await page.screenshot({
        path: path.join(ARTIFACT_DIR, 'transaction-list.png'),
        fullPage: true,
      });
    });
  });
});
