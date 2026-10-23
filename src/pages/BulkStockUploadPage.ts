import { Page, Locator, expect, Download } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { byIdOrLabel } from '../utils/locators';

/**
 * The Bulk Stock Upload dialog, reached from New Shipment on the commodity
 * dashboard.
 *
 * Shape of the dialog, top to bottom:
 *   Select From Facility   Country + a radio list (Supplier is pre-selected)
 *   Select To Facilities   State multi-select, then a destination facility list
 *                          that only renders once the State dropdown closes
 *   Download Stock Template (disabled until both selections are made)
 *   Upload Stock Template   drag-and-drop zone wrapping an input[type=file]
 *   Back / Submit           Submit stays disabled until a file is attached
 *
 * The dialog body scrolls independently of the page. Playwright scrolls a
 * target into view automatically, so the coordinate-swipe gymnastics the
 * Maestro flow required are not needed.
 */
export class BulkStockUploadPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly stateMultiSelect: Locator;
  readonly facilitiesHint: Locator;
  readonly hierarchyWarning: Locator;
  readonly downloadButton: Locator;
  readonly fileInput: Locator;
  readonly submitButton: Locator;
  readonly backButton: Locator;
  /**
   * The whole modal, top to bottom. Scope text-content lookups to this rather
   * than `page` when the dashboard sitting behind the dialog could contain the
   * same text - the Transaction List in particular repeats facility names and
   * codes, so an unscoped `page.getByText(...)` can match a row from it
   * instead of anything the dialog itself is showing.
   */
  readonly dialogContainer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByText('Bulk Stock Upload', { exact: true });
    // Per the strict-mode note below: the entire dialog, heading down to
    // Submit, is one `div role="button"` whose accessible name is every string
    // inside it concatenated. That makes it usable as a scoping root as long as
    // the match stays a prefix rather than `exact: true`.
    this.dialogContainer = page.getByRole('button', {
      name: /^Bulk Stock Upload\b/,
    });
    this.stateMultiSelect = page.locator(
      '[id="campaign-commodity-dashboard-standalone-name-multiselect"]',
    );
    this.facilitiesHint = page.getByText(
      'Select the destination facilities to ship to',
      { exact: true },
    );
    this.hierarchyWarning = page.getByText('Please select hierarchy level first');
    // `exact: true` matters on every role lookup inside this dialog. The whole
    // modal is wrapped in a `div role="button"` whose accessible name is the
    // concatenation of all its text, so a substring name match resolves to
    // both the wrapper and the real control and trips strict mode.
    this.downloadButton = page.getByRole('button', {
      name: 'Download Stock Template',
      exact: true,
    });
    // The upload control is a real input[type=file] behind the drop zone, which
    // is exactly what setInputFiles drives. This is the step Maestro could not
    // do at all.
    this.fileInput = page.locator('input[type="file"]');
    this.submitButton = page.getByRole('button', { name: 'Submit', exact: true });
    this.backButton = page.getByRole('button', { name: 'Back', exact: true });
  }

  /** Ticks a state in the multi-select and closes the dropdown again. */
  async selectState(state: string): Promise<void> {
    await this.stateMultiSelect.click();

    const option = byIdOrLabel(this.page, `Select option: ${state}`);
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();

    // Closing the dropdown is load-bearing, not cosmetic: the destination
    // facility list only renders once it collapses. Clicking the multi-select
    // again just reopens it, so an inert label is used to dismiss it.
    await this.facilitiesHint.click();
  }

  /** Ticks a destination facility by its visible label. */
  async selectDestinationFacility(facilityLabel: string): Promise<void> {
    const facility = this.page
      .getByText(facilityLabel, { exact: true })
      .last();
    await expect(facility).toBeVisible({ timeout: 15_000 });
    await facility.click();

    // Until both a state and a facility are ticked the dialog shows this
    // warning and the download button is disabled, so its disappearance is
    // what proves the two selections registered.
    await expect(this.hierarchyWarning).toBeHidden({ timeout: 15_000 });
    await expect(this.downloadButton).toBeEnabled();
  }

  /**
   * Clicks Download Stock Template and saves the file.
   *
   * Playwright intercepts the browser download rather than letting it land in
   * the OS download folder, so there is no guessing at Chrome's " (2)" suffix.
   */
  async downloadTemplate(targetDir: string): Promise<string> {
    fs.mkdirSync(targetDir, { recursive: true });

    const downloadPromise: Promise<Download> =
      this.page.waitForEvent('download', { timeout: 60_000 });
    await this.downloadButton.click();
    const download = await downloadPromise;

    const suggested = download.suggestedFilename();
    const saveTo = path.join(targetDir, suggested);
    await download.saveAs(saveTo);

    return saveTo;
  }

  /** Attaches the filled template to the drop zone's file input. */
  async uploadTemplate(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File to upload does not exist: ${filePath}`);
    }

    // setInputFiles works on a hidden input, so the drop zone does not need to
    // be scrolled into view or interacted with directly.
    await this.fileInput.setInputFiles(filePath);

    // The component only enables Submit once it has accepted and parsed the
    // sheet, so this is the real confirmation that the upload registered.
    await expect(this.submitButton).toBeEnabled({ timeout: 60_000 });
  }

  /** Submits the shipment. Writes real stock records. */
  async submit(): Promise<void> {
    await this.submitButton.click();
  }
}
