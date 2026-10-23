import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import ExcelJS from 'exceljs';
import { env } from '../src/utils/env';
import { LoginPage } from '../src/pages/LoginPage';
import { CommodityPage } from '../src/pages/CommodityPage';
import { BulkStockUploadPage } from '../src/pages/BulkStockUploadPage';
import { fillStockTemplate } from '../src/utils/stockTemplate';

/**
 * Negative cases for Commodity Management / Bulk Stock Upload.
 *
 * Everything in new-shipment.spec.ts asserts the happy path, which leaves a
 * whole class of bug invisible: the app quietly *accepting* input it should
 * reject. This file covers the other direction.
 *
 * NOTHING HERE SUBMITS. `dialog.submit()` is never called, so this spec is safe
 * to run against production regardless of what HCM_ALLOW_SUBMIT is set to. The
 * upload cases deliberately stop at "did Submit stay disabled".
 *
 * Three tiers, because they have genuinely different setup costs:
 *
 *   1. template writer - pure, no browser launched at all
 *   2. login           - each case needs a *failed* login, so a shared session
 *                        is impossible by definition
 *   3. upload dialog   - serial, sharing one page, so login happens once
 *
 * On assertions of the form "X stays disabled": a bare expect(X).toBeDisabled()
 * passes the instant it is called and would go green even if the control
 * enabled a second later. Those cases settle first, then assert. That is the
 * same non-vacuous discipline the positive spec applies to the batch banner.
 */

/** Long enough for an async validation/parse to have flipped the control. */
const SETTLE_MS = 5_000;

// ---------------------------------------------------------------------------
// Fixtures - deliberately malformed workbooks, built rather than committed so
// they cannot drift from what stockTemplate.ts expects.
// ---------------------------------------------------------------------------

/** A workbook whose sheet is not called 'Stock Data'. */
async function workbookWithWrongSheetName(filePath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Some Other Sheet');
  sheet.addRow(['To (Facility Code)', 'SPAQ 1', 'SPAQ 2']);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

/** A 'Stock Data' sheet that is missing the SPAQ 1 column. */
async function workbookMissingSpaqColumn(filePath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Stock Data');
  sheet.addRow(['To (Facility Code)', 'SPAQ 2']);
  sheet.addRow(['hidden-variant-id-row', '']);
  sheet.addRow(['F-2026-06-13-030843', '']);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

/** A well-formed 'Stock Data' sheet with headers but no facility rows. */
async function workbookWithNoFacilityRows(filePath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Stock Data');
  sheet.addRow(['To (Facility Code)', 'SPAQ 1', 'SPAQ 2']);
  sheet.addRow(['', '', '']); // the hidden variant-id row, nothing beneath it
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

/** Not a spreadsheet at all, despite what the name says. */
function notASpreadsheet(filePath: string): string {
  fs.writeFileSync(filePath, 'this is plain text, not a workbook\n', 'utf8');
  return filePath;
}

/**
 * Takes an already validly-filled template and corrupts its hidden row 2 -
 * the product-variant IDs `fillStockTemplate` is documented to never touch -
 * leaving every visible cell (facility code, quantities) exactly as a real
 * upload would have them.
 */
async function tamperHiddenRow2(
  sourcePath: string,
  outPath: string,
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);

  const sheet = workbook.getWorksheet('Stock Data');
  if (!sheet) {
    throw new Error(`Sheet 'Stock Data' not found in ${sourcePath}`);
  }

  let spaq1Column = -1;
  let spaq2Column = -1;
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const value = String(cell.value ?? '').trim();
    if (value === 'SPAQ 1') spaq1Column = columnNumber;
    if (value === 'SPAQ 2') spaq2Column = columnNumber;
  });
  if (spaq1Column === -1 || spaq2Column === -1) {
    throw new Error(`Could not find SPAQ 1 / SPAQ 2 columns in ${sourcePath}`);
  }

  const row2 = sheet.getRow(2);
  row2.getCell(spaq1Column).value = 'TAMPERED-NOT-A-REAL-VARIANT-ID';
  row2.getCell(spaq2Column).value = 'TAMPERED-NOT-A-REAL-VARIANT-ID';
  row2.commit();

  await workbook.xlsx.writeFile(outPath);
  return outPath;
}

// ---------------------------------------------------------------------------
// 1. Template writer - pure functions, no browser
// ---------------------------------------------------------------------------

test.describe('negative - stock template writer', () => {
  test('rejects a non-integer quantity', async ({}, testInfo) => {
    const source = await workbookMissingSpaqColumn(
      testInfo.outputPath('unused.xlsx'),
    );

    // Validated before the workbook is even opened, so the malformed source
    // never matters - the quantity is what is under test.
    await expect(fillStockTemplate(source, 1.5, 200)).rejects.toThrow(
      /spaq1 must be a whole number of 0 or greater, got 1\.5/,
    );
  });

  test('rejects a negative quantity', async ({}, testInfo) => {
    const source = await workbookMissingSpaqColumn(
      testInfo.outputPath('unused.xlsx'),
    );

    await expect(fillStockTemplate(source, 200, -1)).rejects.toThrow(
      /spaq2 must be a whole number of 0 or greater, got -1/,
    );
  });

  test('names the sheets it did find when Stock Data is missing', async ({}, testInfo) => {
    const source = await workbookWithWrongSheetName(
      testInfo.outputPath('wrong-sheet.xlsx'),
    );

    // The point of the assertion is the diagnosis, not just the throw: a future
    // template that renames the sheet should say so, not fail opaquely.
    await expect(fillStockTemplate(source, 200, 200)).rejects.toThrow(
      /Sheet "Stock Data" not found\. Sheets: \["Some Other Sheet"\]/,
    );
  });

  test('lists the headers present when a SPAQ column is missing', async ({}, testInfo) => {
    const source = await workbookMissingSpaqColumn(
      testInfo.outputPath('missing-column.xlsx'),
    );

    // This is the case that protects against a silent column reorder/rename in
    // a future template version.
    await expect(fillStockTemplate(source, 200, 200)).rejects.toThrow(
      /Column "SPAQ 1" not found in 'Stock Data'\. Headers present: /,
    );
  });

  test('refuses a template with no facility rows to fill', async ({}, testInfo) => {
    const source = await workbookWithNoFacilityRows(
      testInfo.outputPath('no-rows.xlsx'),
    );

    // Writing nothing and reporting success would be the dangerous outcome:
    // an empty upload that looks like it worked.
    await expect(fillStockTemplate(source, 200, 200)).rejects.toThrow(
      /No facility rows found to fill/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Login - a shared session is impossible here, each case needs a failure
// ---------------------------------------------------------------------------

test.describe('negative - login', () => {
  /**
   * Continue is gated on BOTH the city and the privacy checkbox. Each of these
   * two cases therefore fills everything *except* the input under test, asserts
   * Continue is disabled, then supplies that one input and asserts Continue
   * becomes enabled.
   *
   * The second half is what stops the case being vacuous. Asserting only that
   * Continue is disabled would pass for any reason at all - including a
   * completely unrelated missing field - and an earlier version of this file
   * did exactly that, "proving" the checkbox gate while the city was also
   * unset.
   */

  test('Continue is gated on the privacy checkbox', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();

    await login.username.fill(env.userId);
    await login.password.fill(env.password);
    await login.selectCity(env.city);

    // The checkbox is now the only input missing.
    await page.waitForTimeout(SETTLE_MS);
    await expect(login.submitButton).toBeDisabled();

    // Supply it, and the gate opens - which is what proves the checkbox was
    // the thing holding it shut. No credentials are ever submitted here.
    await login.privacyCheckbox.click();
    await expect(login.submitButton).toBeEnabled();
  });

  test('Continue is gated on Country/State/City', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();

    await login.username.fill(env.userId);
    await login.password.fill(env.password);
    await login.privacyCheckbox.click();

    // The city is now the only input missing.
    await page.waitForTimeout(SETTLE_MS);
    await expect(login.submitButton).toBeDisabled();

    await login.selectCity(env.city);
    await expect(login.submitButton).toBeEnabled();
  });

  test('a username that does not exist does not reach the landing page', async ({
    page,
  }) => {
    const login = new LoginPage(page);
    await login.goto();

    // Deliberately a bogus username rather than the real one with a bad
    // password: repeated failures against a real account risk locking it out,
    // and this proves the same thing.
    await login.username.fill('hcm-playwright-no-such-user');
    await login.password.fill('not-a-real-password');
    await login.selectCity(env.city);
    await login.privacyCheckbox.click();

    // Continue has to actually be reachable, or the case never gets as far as
    // testing what it claims to test.
    await expect(login.submitButton).toBeEnabled();
    await login.submitButton.click();

    // The landing page must never render. Asserting an error toast instead
    // would be guesswork - this suite has never observed one.
    await expect(
      page.locator('[id="Landing page content"], [aria-label="Landing page content"]'),
    ).toHaveCount(0, { timeout: 30_000 });

    // And we are still on the login form rather than somewhere unexpected.
    await expect(login.username).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 3. Upload dialog - serial, one shared page, so this tier logs in exactly once
// ---------------------------------------------------------------------------

test.describe.serial('negative - Bulk Stock Upload dialog', () => {
  let page: Page;
  let dialog: BulkStockUploadPage;

  test.beforeAll(async ({ browser }) => {
    // browser.newPage() does not inherit `use` from the config, so the viewport
    // and TLS handling are restated to match the rest of the suite.
    page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      ignoreHTTPSErrors: true,
    });

    const login = new LoginPage(page);
    const commodity = new CommodityPage(page);
    dialog = new BulkStockUploadPage(page);

    await login.loginAndWait();
    await commodity.openModule();
    await commodity.searchCampaign(env.campaignName);
    await commodity.openDashboard();
    await commodity.openNewShipment();
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('Download and Submit are both disabled before anything is selected', async () => {
    await expect(dialog.heading).toBeVisible();

    // The app's own explanation of why Download is unavailable.
    await expect(dialog.hierarchyWarning).toBeVisible();
    await expect(dialog.downloadButton).toBeDisabled();
    await expect(dialog.submitButton).toBeDisabled();
  });

  test('Download stays disabled when only the state is selected', async () => {
    await dialog.selectState(env.city);

    // A destination facility is still missing, so the dialog cannot yet
    // produce a template.
    await page.waitForTimeout(SETTLE_MS);
    await expect(dialog.downloadButton).toBeDisabled();

    // The warning and the Download gate are driven by DIFFERENT conditions,
    // which is easy to get wrong: "Please select hierarchy level first" clears
    // as soon as the state is picked, while Download stays shut until a
    // facility is ticked too. So the warning being gone is not evidence the
    // dialog is ready - only the button state is.
    await expect(dialog.hierarchyWarning).toBeHidden();
  });

  test('Submit stays disabled after uploading a file that is not a spreadsheet', async ({}, testInfo) => {
    // Arrange: complete the selection so the upload control is the only thing
    // under test. This is the one positive action in the file.
    await dialog.selectDestinationFacility(env.toFacility);
    await expect(dialog.downloadButton).toBeEnabled();

    const bogus = notASpreadsheet(testInfo.outputPath('not-a-workbook.txt'));
    await dialog.fileInput.setInputFiles(bogus);

    // Submit becoming enabled is the component's signal that it parsed the
    // sheet. Settle first: asserting immediately would pass before any
    // validation had a chance to run.
    await page.waitForTimeout(SETTLE_MS);
    await expect(dialog.submitButton).toBeDisabled();
  });

  test('Submit stays disabled after the hidden product-variant-ID row is tampered with', async ({}, testInfo) => {
    /**
     * KNOWN DEFECT, confirmed 2026-09-28 against Bauchi.
     *
     * Row 2 is hidden and carries product-variant IDs the template's own
     * ReadMe sheet says must never be touched. Every other case in this file
     * builds a workbook from scratch and never has a real row 2 to corrupt;
     * this one downloads the actual template so the tampered value is a real
     * corruption of real data, not an invented shape - a real facility row,
     * valid quantities written by the real fillStockTemplate, and ONLY row
     * 2's variant IDs replaced with a value that cannot correspond to any
     * real product variant.
     *
     * That was accepted with no error, no warning, and Submit became
     * enabled - a third distinct way this same shared Upload/Submit
     * component fails to look inside the workbook it accepts, alongside the
     * wrong-sheet-name defect below and the over-balance-quantity defect in
     * state-negativecases.spec.ts. All three are one plausible root cause
     * (no server-side content validation of any kind) manifesting three
     * ways - worth raising with the app team together rather than
     * separately, see testcases.md.
     *
     * test.fail() rather than deleted or inverted, same reasoning as the
     * wrong-sheet-name defect immediately below: Playwright reports an
     * unexpected *pass* as a failure, so the day this is fixed the suite
     * says so and this annotation can come out.
     *
     * What the backend does with such a file is untested - finding out means
     * clicking Submit, which writes.
     */
    test.fail();

    const downloaded = await dialog.downloadTemplate(
      testInfo.outputPath('downloaded'),
    );
    const filled = await fillStockTemplate(
      downloaded,
      env.spaq1,
      env.spaq2,
      testInfo.outputPath('valid-before-tamper.xlsx'),
    );
    const tampered = await tamperHiddenRow2(
      filled.filledPath,
      testInfo.outputPath('tampered-row2.xlsx'),
    );

    await dialog.fileInput.setInputFiles(tampered);

    await page.waitForTimeout(SETTLE_MS);
    await expect(dialog.submitButton).toBeDisabled();
  });

  test('Submit stays disabled after uploading a workbook with no Stock Data sheet', async ({}, testInfo) => {
    /**
     * KNOWN DEFECT - this assertion currently fails against the app.
     *
     * Observed 2026-09-23 against Bauchi: uploading a valid .xlsx whose sheet
     * is not named 'Stock Data' is accepted with no error shown, and Submit
     * becomes enabled. The previous case proves a plain .txt *is* rejected, so
     * validation is checking the file type and never looking inside the
     * workbook.
     *
     * Marked test.fail() rather than deleted or inverted: inverting it would
     * bless the behaviour, and deleting it would lose the finding. Playwright
     * reports an unexpected *pass* as a failure, so the day this is fixed the
     * suite will say so and this annotation can come out.
     *
     * What the backend does with such a file is untested - finding out means
     * clicking Submit, which writes.
     */
    test.fail();

    const wrongShape = await workbookWithWrongSheetName(
      testInfo.outputPath('wrong-sheet.xlsx'),
    );
    await dialog.fileInput.setInputFiles(wrongShape);

    // Right file type, wrong internal shape - the harder of the two to reject,
    // and the one a naive implementation would accept.
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
