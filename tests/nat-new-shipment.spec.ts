import { test, expect } from '@playwright/test';
import path from 'path';
import { env } from '../src/utils/env';
import { LoginPage } from '../src/pages/LoginPage';
import { CommodityPage } from '../src/pages/CommodityPage';
import { BulkStockUploadPage } from '../src/pages/BulkStockUploadPage';
import { fillStockTemplate, readStockQuantities } from '../src/utils/stockTemplate';

/**
 * New Shipment - the full Bulk Stock Upload round trip, end to end.
 *
 *   login -> Commodity Management -> campaign dashboard -> New Shipment
 *   -> select State and destination facility
 *   -> download the stock template
 *   -> write SPAQ 1 / SPAQ 2
 *   -> upload the filled template
 *   -> Submit
 *   -> wait for the batch to finish
 *   -> verify the Transaction List on the same dashboard
 *
 * This exists because Maestro cannot upload a file. See MAESTRO-LIMITATIONS.md
 * in the hcm-web-automation repo for the four techniques that were tried there
 * and why each failed.
 *
 * Deliberately one test rather than two. Playwright gives every test a fresh
 * browser context, so a second test would mean a second sign-in - and sign-in
 * round-trips the employee's tenant and role set, which is the slowest step in
 * the journey. Keeping the whole flow in one test is what makes it a single
 * login, and it also lets the Transaction List be checked on the very dashboard
 * the shipment was just submitted from instead of navigating back to it.
 *
 * Submitting writes real stock records to whatever HCM_WEB_URL points at. The
 * HCM_ALLOW_SUBMIT gate is still here and still defaults to off; set it to the
 * exact string "true" to authorise the write.
 */

const ARTIFACT_DIR = path.resolve(__dirname, '..', 'artifacts', 'new-shipment');

test.describe('Commodity Management - New Shipment', () => {
  test('bulk stock upload: download, fill SPAQ 1/2, upload, submit and verify', async ({
    page,
  }) => {
    const login = new LoginPage(page);
    const commodity = new CommodityPage(page);
    const dialog = new BulkStockUploadPage(page);

    await test.step('sign in', async () => {
      await login.loginAndWait();
    });

    await test.step('open the campaign dashboard', async () => {
      await commodity.openModule();
      await commodity.searchCampaign(env.campaignName);
      await commodity.openDashboard();
    });

    await test.step('open Bulk Stock Upload', async () => {
      await commodity.openNewShipment();
      await expect(dialog.heading).toBeVisible();
    });

    await test.step('select the state and destination facility', async () => {
      await dialog.selectState(env.city);
      await dialog.selectDestinationFacility(env.toFacility);
    });

    let filledPath = '';

    await test.step('download the stock template', async () => {
      const downloaded = await dialog.downloadTemplate(ARTIFACT_DIR);
      expect(downloaded).toMatch(/\.xlsx$/);

      const result = await fillStockTemplate(
        downloaded,
        env.spaq1,
        env.spaq2,
        path.join(ARTIFACT_DIR, 'Stock_Template_filled.xlsx'),
      );
      filledPath = result.filledPath;
      expect(result.rowsFilled).toBeGreaterThan(0);

      // Read the quantities back off disk rather than trusting the writer.
      const rows = await readStockQuantities(filledPath);
      expect(rows.length).toBe(result.rowsFilled);
      for (const row of rows) {
        expect(Number(row.spaq1)).toBe(env.spaq1);
        expect(Number(row.spaq2)).toBe(env.spaq2);
      }
    });

    await test.step('upload the filled template', async () => {
      await dialog.uploadTemplate(filledPath);
    });

    let submitted = false;

    await test.step('submit the shipment', async () => {
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
      submitted = true;

      // The dialog closing only means the upload was accepted. The records are
      // created asynchronously afterwards, and the dashboard reports progress
      // as "Creating batch 1 of 1... N/M records processed | K failed".
      // Asserting on the dialog alone passes while the batch is still at 0/2,
      // so it would go green even if every record subsequently failed.
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
        // Either the banner cleared, or processed count caught up with the
        // total - the backreference is what makes "2/2" pass and "0/2" not.
        .toMatch(/^batch-banner-gone$|^(\d+)\/\1 records processed/);

      // Nothing may have failed in the batch.
      if ((await progress.count()) > 0) {
        await expect(progress.first()).toContainText('0 failed');
      }
    });

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, 'after-submit.png'),
      fullPage: true,
    });

    await test.step('verify the Transaction List', async () => {
      // Already on the dashboard the shipment was submitted from, so this needs
      // no navigation and no second login. When a submit happened, the batch
      // assertion above is what proves the records were created; the list is
      // then checked for having rendered them.
      const transactionList = page.getByText('Transaction List', { exact: true });
      await expect(transactionList).toBeVisible({ timeout: 120_000 });

      // Column headers, so a layout change that drops a column is caught.
      for (const header of ['TRN', 'Sent from', 'Sent to', 'Status', 'Quantity']) {
        await expect(
          page.getByText(header, { exact: true }).first(),
        ).toBeVisible();
      }

      // Live production data - assert the table has rows, never a specific
      // count. New records do not necessarily sort onto page 1, so the count is
      // recorded as an annotation rather than asserted to have grown.
      const trnCells = page.getByText(/^S-\d{4}-\d{2}-\d{2}-\d+$/);
      await expect(trnCells.first()).toBeVisible({ timeout: 60_000 });
      const rowCount = await trnCells.count();
      expect(rowCount).toBeGreaterThan(0);

      await page.screenshot({
        path: path.join(ARTIFACT_DIR, 'transaction-list.png'),
        fullPage: true,
      });

      test.info().annotations.push({
        type: 'transaction-rows',
        description:
          `${rowCount} transaction rows visible on page 1` +
          (submitted ? ' (after submitting this shipment)' : ' (nothing submitted)'),
      });
    });
  });
});
