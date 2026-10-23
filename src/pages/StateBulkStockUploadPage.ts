import { Page, Locator, expect } from '@playwright/test';
import { BulkStockUploadPage } from './BulkStockUploadPage';
import { byIdOrLabel } from '../utils/locators';

/**
 * The Bulk Stock Upload dialog as the *state* user sees it.
 *
 * The bottom half - Download, Upload, Back, Submit - is identical to the
 * supplier's, so it is inherited. The top half is not:
 *
 *   Select From Facility   a State dropdown pre-filled with the tenant, a
 *                          search box, and a radio list of warehouses. For this
 *                          user the source warehouse arrives already selected.
 *   Select To Facilities   a three-level cascade - LGA, then Ward, then Health
 *                          Facility - each level appearing only once the one
 *                          above it is set, followed by a checkbox list of the
 *                          actual facilities.
 *
 * Three quirks make this dialog awkward, all confirmed against Bauchi:
 *
 *   1. All three cascade selects carry the SAME id,
 *      `campaign-commodity-dashboard-standalone-name-multiselect`. There is no
 *      per-level id to anchor on, so they are addressed by position - LGA 0,
 *      Ward 1, Health Facility 2 - which is safe because each level only
 *      renders once its parent is set, and because every selection is then
 *      confirmed by waiting for that level's chip.
 *   2. A facility checkbox list renders under EVERY level, not only the last -
 *      picking just the LGA already offers that LGA's store. Its appearance
 *      shifts everything beneath it, which is why each level is driven through
 *      its own search input rather than by clicking a control that may have
 *      moved out from under the pointer.
 *   3. The boundary fetch behind that list intermittently returns nothing, and
 *      the dialog then sits on `No facilities found for the selected boundary`
 *      without ever recovering. Waiting longer does not help - 90 seconds was
 *      tried - but clearing the level and picking it again does, because that
 *      issues a fresh request. See selectHealthFacilityWithList.
 */
export class StateBulkStockUploadPage extends BulkStockUploadPage {
  readonly fromFacilityHeading: Locator;
  readonly fromStateDropdown: Locator;
  readonly cascadeSelects: Locator;
  readonly noFacilitiesMessage: Locator;

  /** Cascade levels, in the order the dialog reveals them. */
  private static readonly LGA = 0;
  private static readonly WARD = 1;
  private static readonly HEALTH_FACILITY = 2;

  constructor(page: Page) {
    super(page);
    this.fromFacilityHeading = page.getByText('Select From Facility', {
      exact: true,
    });
    this.fromStateDropdown = page.locator(
      'input[id="campaign-commodity-dashboard-standalone-name-dropdown"]',
    );
    this.cascadeSelects = page.locator(
      '[id="campaign-commodity-dashboard-standalone-name-multiselect"]',
    );
    this.noFacilitiesMessage = page.getByText(
      'No facilities found for the selected boundary',
    );
  }

  /**
   * Confirms the source warehouse the dialog opened with.
   *
   * Asserted rather than selected: for the state user this radio arrives
   * already checked. Clicking it would hide a regression in which the app
   * stopped pre-selecting it.
   */
  async expectSourceFacility(facilityLabel: string): Promise<void> {
    await expect(this.fromFacilityHeading).toBeVisible();

    const radio = this.page.getByRole('radio', { name: facilityLabel });
    await expect(radio).toBeVisible({ timeout: 30_000 });
    await expect(radio).toBeChecked();

    // The dialog's own confirmation line, e.g. "Selected: State CMS".
    const shortName = facilityLabel.replace(/\s*\(.*\)$/, '').trim();
    await expect(
      this.page.getByText(`Selected: ${shortName}`, { exact: true }),
    ).toBeVisible();
  }

  /**
   * Ticks one value in the cascade level at `levelIndex` and waits for its
   * chip, which is what proves the click landed on the intended level.
   */
  private async pickLevel(
    levelIndex: number,
    optionName: string,
  ): Promise<void> {
    await expect
      .poll(async () => this.cascadeSelects.count(), {
        timeout: 30_000,
        message: `cascade level ${levelIndex} never appeared`,
      })
      .toBeGreaterThan(levelIndex);

    const select = this.cascadeSelects.nth(levelIndex);

    /**
     * Driven through the multi-select's own search input rather than by
     * clicking the container.
     *
     * Two reasons, both observed. Selecting a level makes a facility list
     * render underneath, which shifts the levels below it - so a click aimed
     * at the container can miss. And each level's option list can be long
     * enough that the wanted entry is not rendered until it is filtered.
     * Typing solves both: it focuses and opens the control, and narrows the
     * list to the option being asked for.
     */
    const search = select.locator('input').first();
    await search.click();
    await search.fill(optionName);

    const option = byIdOrLabel(this.page, `Select option: ${optionName}`);
    await expect(option).toBeVisible({ timeout: 15_000 });
    await option.click();

    // Same trick the supplier flow needs: the dropdown has to be dismissed by
    // something inert, because clicking the select again just reopens it.
    await this.facilitiesHint.click();

    // The chip is the app's own confirmation that this level now holds that
    // value - and it names the level, so a mis-indexed click cannot pass.
    await expect(
      this.page.getByRole('group', {
        name: `${optionName} chip with remove button`,
      }),
    ).toBeVisible({ timeout: 15_000 });
  }

  /**
   * Waits for the cascade to have grown to `expected` levels.
   *
   * Each level's options are fetched for whatever its parent now holds, so
   * driving the three picks back to back can select from a list that has not
   * been refiltered yet. The chip still appears, so the selection *looks*
   * right while the underlying boundary is inconsistent - and the facility
   * list then comes back "No facilities found for the selected boundary".
   * Waiting for the next level to materialise is the app's own signal that it
   * has processed the level above.
   */
  private async expectLevelCount(expected: number): Promise<void> {
    await expect
      .poll(async () => this.cascadeSelects.count(), {
        timeout: 60_000,
        message: `the cascade never grew to ${expected} levels`,
      })
      .toBeGreaterThanOrEqual(expected);
  }

  async selectLga(lga: string): Promise<void> {
    await this.pickLevel(StateBulkStockUploadPage.LGA, lga);
    // Ward should now exist, filtered by this LGA.
    await this.expectLevelCount(2);
  }

  async selectWard(ward: string): Promise<void> {
    await this.pickLevel(StateBulkStockUploadPage.WARD, ward);
    // Health Facility should now exist, filtered by this Ward.
    await this.expectLevelCount(3);
  }

  async selectHealthFacility(name: string): Promise<void> {
    await this.pickLevel(StateBulkStockUploadPage.HEALTH_FACILITY, name);
  }

  /** The code out of "ba Lamba Health Post (F-2025-06-19-003123)". */
  private static facilityCode(label: string): string {
    return label.match(/\(([^)]+)\)\s*$/)?.[1] ?? label;
  }

  /**
   * Waits for one specific facility row to appear in the checkbox list.
   *
   * Deliberately NOT a wait on "Select All". A checkbox list renders under
   * every cascade level, so "Select All" is already on screen from the level
   * above - waiting on it is satisfied instantly and proves nothing about the
   * list having refreshed for the boundary just chosen. Waiting for the wanted
   * facility is the only signal that actually means what it needs to mean.
   */
  private async waitForFacility(
    code: string,
    timeoutMs: number,
  ): Promise<boolean> {
    // Scoped to the dialog, not the whole page: the Transaction List sitting
    // behind the modal can already show this same facility code from a past
    // shipment, which would satisfy an unscoped match instantly and hide a
    // genuine "No facilities found for the selected boundary" underneath.
    return this.dialogContainer
      .getByText(new RegExp(code))
      .last()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Selects the Health Facility level and waits for its facility list, retrying
   * the selection if the list does not arrive.
   *
   * The list is fetched for the boundary the cascade describes, and that fetch
   * intermittently produces nothing - the dialog then sits on "No facilities
   * found for the selected boundary" indefinitely rather than recovering. It is
   * not slowness: waiting 90 seconds does not help, while clearing the level
   * and picking it again does, because that issues a fresh request.
   *
   * So the retry re-picks rather than waits longer.
   */
  async selectHealthFacilityWithList(
    healthFacilityName: string,
    facilityLabel: string,
    attempts = 5,
  ): Promise<void> {
    const code = StateBulkStockUploadPage.facilityCode(facilityLabel);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt === 1) {
        await this.pickLevel(
          StateBulkStockUploadPage.HEALTH_FACILITY,
          healthFacilityName,
        );
      } else {
        // Clear the level and re-pick it, which re-issues the boundary fetch.
        const remove = this.page.getByRole('button', {
          name: `Remove ${healthFacilityName}`,
        });
        if ((await remove.count()) > 0) {
          await remove.first().click();
          await this.page.waitForTimeout(3_000);
        }
        await this.pickLevel(
          StateBulkStockUploadPage.HEALTH_FACILITY,
          healthFacilityName,
        );
      }

      // Give the list time to refresh for the boundary now selected. Only
      // after this has genuinely expired is a retry worth attempting - an
      // earlier version checked once, immediately, and re-picked a level that
      // was merely still loading.
      if (await this.waitForFacility(code, 60_000)) {
        await this.dialogContainer.getByText(new RegExp(code)).last().click();
        await expect(this.downloadButton).toBeEnabled({ timeout: 30_000 });
        return;
      }
    }

    // Still nothing after every attempt - report what the boundary does offer,
    // so the next reader can tell a wrong boundary from a failed fetch. Scoped
    // to the dialog for the same reason waitForFacility is: the Transaction
    // List behind the modal carries its own facility codes and would otherwise
    // be reported as if the dialog had offered them.
    const offered = await this.dialogContainer
      .getByText(/F-\d{4}-\d{2}-\d{2}-\d+/)
      .allTextContents();
    throw new Error(
      `${JSON.stringify(facilityLabel)} never appeared in the facility list ` +
        `after ${attempts} attempts, each waiting 60s. The list offers: ` +
        `${JSON.stringify(offered.slice(0, 20))}`,
    );
  }

}
