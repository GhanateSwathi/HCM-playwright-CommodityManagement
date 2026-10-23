import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { env, stateEnv } from '../src/utils/env';
import { LoginPage } from '../src/pages/LoginPage';
import { CommodityPage } from '../src/pages/CommodityPage';
import { StateBulkStockUploadPage } from '../src/pages/StateBulkStockUploadPage';
import { fillStockTemplate } from '../src/utils/stockTemplate';
import { readStockBalances } from '../src/utils/stockSummary';

/**
 * Negative cases for the STATE user's Bulk Stock Upload dialog.
 *
 * A separate file from nat-negativecases.spec.ts on purpose, not a set of
 * cases bolted onto it: the state dialog's top half - the pre-selected source
 * warehouse, and the LGA -> Ward -> Health Facility cascade - has no
 * equivalent in the supplier flow, so none of its gating behaviour is covered
 * anywhere else. The bottom half (Upload/Submit) *is* the same shared
 * BulkStockUploadPage component the supplier dialog uses - see
 * StateBulkStockUploadPage's own module doc, "identical to the supplier's, so
 * it is inherited" - so two of the upload-validation cases here (non-spreadsheet,
 * wrong sheet name) are a check that the shared component still behaves once
 * it is reached through three cascade picks instead of one, not a hunt for a
 * second bug. The third upload case - a quantity over the warehouse balance -
 * genuinely is new: it depends on this flow's own live balance, which the
 * supplier flow has no equivalent of at all.
 *
 * NOTHING HERE SUBMITS. dialog.submit() is never called, so this file is safe
 * to run against production regardless of what HCM_ALLOW_SUBMIT is set to.
 *
 * Template-writer and login negative cases are deliberately NOT duplicated
 * here. fillStockTemplate() does not know or care which flow called it, and
 * LoginPage.login() is exactly the same code path for stateEnv credentials as
 * for env's - nat-negativecases.spec.ts already covers both, and re-running
 * them against a second set of credentials would test the same code again,
 * not new code.
 *
 * One describe.serial block, one login, one walk down the cascade - it is
 * cumulative rather than independent per case, same reasoning as
 * nat-negativecases.spec.ts's dialog tier. The state cascade's boundary fetch
 * is slow and occasionally needs retries (StateBulkStockUploadPage quirk #3),
 * so repeating the LGA -> Ward -> Health Facility walk once per test would
 * make this file needlessly expensive and needlessly exposed to that flake.
 */

const SETTLE_MS = 5_000;

const SPAQ1_PRODUCT = 'SP - SPAQ 1';
const SPAQ2_PRODUCT = 'SP - SPAQ 2';
const ARTIFACT_DIR = path.resolve(__dirname, '..', 'artifacts', 'state-negativecases');

// ---------------------------------------------------------------------------
// Fixtures - same shapes as nat-negativecases.spec.ts, kept local rather than
// shared: that file defines its own fixtures locally too rather than
// importing them, so this follows the convention already in place.
// ---------------------------------------------------------------------------

/** A workbook whose sheet is not called 'Stock Data'. */
async function workbookWithWrongSheetName(filePath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Some Other Sheet');
  sheet.addRow(['To (Facility Code)', 'SPAQ 1', 'SPAQ 2']);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

/** Not a spreadsheet at all, despite what the name says. */
function notASpreadsheet(filePath: string): string {
  fs.writeFileSync(filePath, 'this is plain text, not a workbook\n', 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// State Bulk Stock Upload dialog - serial, one shared page and one shared
// cascade walk
// ---------------------------------------------------------------------------

test.describe.configure({ timeout: 10 * 60 * 1000 });

test.describe.serial('negative - state Bulk Stock Upload dialog', () => {
  let page: Page;
  let dialog: StateBulkStockUploadPage;
  let balance1 = 0;
  let balance2 = 0;

  test.beforeAll(async ({ browser }) => {
    // Reading Stock Summary can take several minutes in the worst case (see
    // stockSummary.ts) on top of the dialog setup below, so this hook gets its
    // own explicit budget rather than trusting whatever the ambient default is.
    test.setTimeout(10 * 60 * 1000);

    // browser.newPage() does not inherit `use` from the config, so the
    // viewport and TLS handling are restated to match the rest of the suite.
    page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      ignoreHTTPSErrors: true,
    });

    const login = new LoginPage(page);
    const commodity = new CommodityPage(page);
    dialog = new StateBulkStockUploadPage(page);

    await login.loginAndWait(stateEnv.userId, stateEnv.password);
    await commodity.openModule();
    await commodity.searchCampaign(env.campaignName);
    await commodity.openDashboard();

    // Read the real balances before opening the dialog - same order as
    // state-new-shipment.spec.ts, and for the same reason: reading it after
    // opening the dialog isn't an option (Stock Summary is a dashboard tab,
    // hidden behind the modal), and opening the dialog while Stock Summary is
    // still showing has left the destination facility list unrendered before.
    const balances = await readStockBalances(page, [SPAQ1_PRODUCT, SPAQ2_PRODUCT]);
    balance1 = balances.get(SPAQ1_PRODUCT)!;
    balance2 = balances.get(SPAQ2_PRODUCT)!;

    // Same settle the happy-path spec needs before opening the dialog: the
    // dashboard keeps fetching after the campaign loads, and opening the
    // shipment dialog into that traffic is when the destination facility list
    // is most likely to come back empty. See state-new-shipment.spec.ts.
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(30_000);

    await commodity.openNewShipment();
    await expect(dialog.heading).toBeVisible();
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('the source warehouse arrives pre-selected, and Download/Submit are disabled before any destination is chosen', async () => {
    // Asserted, not selected: for the state user this radio arrives already
    // checked, so confirming it here is what proves the case starts from the
    // same state a real user sees, not a dialog this suite half-configured.
    await dialog.expectSourceFacility(stateEnv.fromFacility);

    await page.waitForTimeout(SETTLE_MS);
    await expect(dialog.downloadButton).toBeDisabled();
    await expect(dialog.submitButton).toBeDisabled();
  });

  test('the Ward and Health Facility levels do not exist before an LGA is chosen', async () => {
    // Only the LGA level should be on screen - Ward and Health Facility are
    // meant to render only once the level above them is set. If this ever
    // shows more than 1, the cascade is exposing a level before its parent
    // boundary exists.
    await expect(dialog.cascadeSelects).toHaveCount(1);
  });

  test('Ward appears but Health Facility does not, and Download stays disabled, once only the LGA is picked', async () => {
    await dialog.selectLga(stateEnv.lga);

    // Health Facility must not have appeared yet - only LGA and Ward.
    await expect(dialog.cascadeSelects).toHaveCount(2);

    await page.waitForTimeout(SETTLE_MS);
    await expect(dialog.downloadButton).toBeDisabled();
  });

  test('Health Facility appears, and Download stays disabled, once LGA + Ward are picked but no facility is ticked', async () => {
    await dialog.selectWard(stateEnv.ward);

    await expect(dialog.cascadeSelects).toHaveCount(3);

    await page.waitForTimeout(SETTLE_MS);
    await expect(dialog.downloadButton).toBeDisabled();
  });

  test('Download becomes enabled once a Health Facility is ticked', async () => {
    await dialog.selectHealthFacilityWithList(
      stateEnv.toFacilityName,
      stateEnv.toFacility,
    );

    // selectHealthFacilityWithList already asserts this on success, but
    // restating it here is the point of the case, not incidental.
    await expect(dialog.downloadButton).toBeEnabled();
  });

  test('Removing the LGA chip leaves Ward/Health Facility selected and Download enabled', async () => {
    /**
     * KNOWN DEFECT, confirmed 2026-09-29 against Bauchi.
     *
     * The cascade's documented behaviour is that each level renders only
     * once its parent is set (see StateBulkStockUploadPage's module doc).
     * The natural expectation from that is the reverse too: clearing the top
     * level should reset the levels below it, and Download should go back to
     * disabled until a complete, consistent boundary is chosen again.
     *
     * That is not what happens. Removing the LGA chip leaves LGA's own
     * dropdown empty, but Ward ("Lanzai West") and Health Facility ("ba
     * Lamba Health Post") both keep their previous selections, the cascade
     * still shows all 3 levels, and **Download stays enabled** - confirmed
     * by actually downloading a real template in this exact state, which
     * succeeded and produced a file still addressed to ba Lamba Health Post
     * despite no LGA being selected at all. A user who removes their LGA to
     * pick a different one, changes their mind, or misclicks has no visible
     * signal that the destination they are about to ship to no longer has a
     * selected LGA behind it.
     *
     * Originally left out of this file for cost - it re-walks the slow,
     * sometimes-retried boundary fetch - but worth it for what it found.
     * test.fail() rather than deleted or inverted, same reasoning as every
     * other defect in this file: an unexpected pass is Playwright's own
     * signal that this got fixed.
     */
    test.fail();

    await page.getByRole('button', { name: `Remove ${stateEnv.lga}` }).click();
    await page.waitForTimeout(SETTLE_MS * 2);

    await expect(dialog.cascadeSelects).toHaveCount(1);
    await expect(dialog.downloadButton).toBeDisabled();
  });

  test('Re-picking the LGA restores a consistent selection', async () => {
    // The previous case leaves the dialog in the confirmed-inconsistent
    // state described above: LGA empty, Ward and Health Facility still
    // holding valid values for that same LGA. Every case after this one
    // needs a genuinely working destination selection, so this restores it
    // by re-picking the same LGA rather than clearing and re-walking the
    // whole slow cascade a second time.
    await dialog.selectLga(stateEnv.lga);
    await expect(dialog.downloadButton).toBeEnabled();
  });

  test('Submit stays disabled after uploading a quantity greater than the warehouse balance', async () => {
    /**
     * KNOWN DEFECT, confirmed 2026-09-25 against Bauchi.
     *
     * Balances at read time this run: SPAQ1=169200, SPAQ2=868649. Uploaded
     * SPAQ1=169250, SPAQ2=868699 - only 50 over each, deliberately a small
     * margin rather than an implausibly huge one, so this isn't merely
     * confirming a guard against wildly-absurd numbers. The dialog accepted
     * the file with no error, no warning, and no visible difference from a
     * normal valid upload - the filename simply appears next to
     * Download/Delete controls exactly as it does for a valid quantity - and
     * Submit became enabled.
     *
     * The shared upload component validates the file's *shape* (sheet name,
     * columns - see nat-negativecases.spec.ts's own known defect for the
     * sibling finding on file *content*) but not the requested quantity
     * against what the warehouse actually holds. state-new-shipment.spec.ts's
     * own quantity write path exists specifically so the suite itself never
     * tries this in a real submit - "shipping more than a warehouse holds ...
     * would create records that should not exist" - and this case confirms
     * that gap is real on the app side too, not just avoided by the test's
     * own restraint.
     *
     * test.fail() rather than deleting/inverting, same reasoning as the
     * wrong-sheet-name defect: Playwright reports an unexpected *pass* as a
     * failure, so the day the app validates this, the suite reports it and
     * this annotation can come out.
     *
     * What clicking Submit would actually do with such a file is untested -
     * finding out means writing an invalid stock record.
     */
    test.fail();

    // Comfortably over whatever the balance is, including if it is already
    // zero or negative.
    const overQty1 = Math.max(balance1, 0) + 50;
    const overQty2 = Math.max(balance2, 0) + 50;

    const downloaded = await dialog.downloadTemplate(ARTIFACT_DIR);
    const result = await fillStockTemplate(
      downloaded,
      overQty1,
      overQty2,
      path.join(ARTIFACT_DIR, 'Stock_Template_overbalance.xlsx'),
    );
    expect(result.rowsFilled).toBeGreaterThan(0);

    // Attach directly rather than via dialog.uploadTemplate(): that helper
    // asserts Submit becomes enabled within 60s, which is the opposite of
    // what this case expects (even though it currently fails to happen).
    await dialog.fileInput.setInputFiles(result.filledPath);
    await page.waitForTimeout(SETTLE_MS * 4);

    try {
      await expect(dialog.submitButton).toBeDisabled();
    } finally {
      // Once a file is accepted, the drop zone is replaced by a file-card
      // view (filename + Download/Delete), and dialog.fileInput stops
      // resolving the same way - the next cases need the file removed to get
      // a working input back, regardless of whether the assertion above
      // passed or (as expected) threw.
      const deleteButton = dialog.dialogContainer.getByRole('button', {
        name: 'Delete',
        exact: true,
      });
      if ((await deleteButton.count()) > 0) {
        await deleteButton.click();
      }
    }
  });

  test('Submit stays disabled after uploading a file that is not a spreadsheet', async ({}, testInfo) => {
    const bogus = notASpreadsheet(testInfo.outputPath('not-a-workbook.txt'));
    await dialog.fileInput.setInputFiles(bogus);

    // Settle first: asserting immediately would pass before any validation
    // had a chance to run, which would be true regardless of whether the
    // control ever rejects the file.
    await page.waitForTimeout(SETTLE_MS);
    await expect(dialog.submitButton).toBeDisabled();
  });

  test('Submit stays disabled after uploading a workbook with no Stock Data sheet', async ({}, testInfo) => {
    /**
     * KNOWN DEFECT, same one nat-negativecases.spec.ts records - this
     * assertion is expected to currently fail against the app.
     *
     * The Upload/Submit half of this dialog is the same BulkStockUploadPage
     * component the supplier flow uses, so the defect observed there (file
     * *type* is validated, file *contents* are not - a valid .xlsx with the
     * wrong sheet name is accepted and Submit becomes enabled) is expected to
     * reproduce here too. test.fail() rather than deleting or inverting the
     * case: inverting would bless the behaviour, and if this ever starts
     * failing (i.e. the assertion starts passing) Playwright reports the
     * unexpected pass as a failure, which is the signal that the shared
     * component was fixed and this annotation can come out.
     */
    test.fail();

    const wrongShape = await workbookWithWrongSheetName(
      testInfo.outputPath('wrong-sheet.xlsx'),
    );
    await dialog.fileInput.setInputFiles(wrongShape);

    await page.waitForTimeout(SETTLE_MS);
    await expect(dialog.submitButton).toBeDisabled();
  });

  test('Back closes the dialog without submitting anything', async () => {
    await dialog.backButton.click();

    await expect(dialog.heading).toBeHidden({ timeout: 30_000 });

    // No batch was kicked off, so the dashboard must not be reporting one.
    await expect(page.getByText(/\d+\/\d+ records processed/)).toHaveCount(0);
  });
});
