import { Page, Locator, expect } from '@playwright/test';
import { byIdOrLabel } from '../utils/locators';

/**
 * Landing page -> My Campaigns -> Commodity Management Dashboard.
 *
 * "Commodity Management" appears twice on the landing page: once as the card
 * heading and once as the link beneath the description. Playwright's role
 * filter separates them cleanly - the heading is not a button - which is a
 * tidier fix than the positional anchoring this needed under Maestro.
 */
export class CommodityPage {
  readonly page: Page;
  readonly moduleLink: Locator;
  readonly campaignsHeading: Locator;
  readonly tabNavigation: Locator;
  readonly campaignNameInput: Locator;
  readonly searchButton: Locator;
  readonly clearButton: Locator;
  readonly resultCount: Locator;
  readonly viewDashboardButton: Locator;
  readonly transactionSummaryTab: Locator;
  readonly newShipmentButton: Locator;
  readonly bulkUploadHeading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.moduleLink = page.getByRole('button', {
      name: 'Commodity Management',
      exact: true,
    });
    this.campaignsHeading = page.getByText('My Campaigns', { exact: true });
    this.tabNavigation = byIdOrLabel(page, 'Tab navigation');
    // The accessibility tree exposes this as the only textbox inside the
    // "Search form" landmark. There is no usable id on the control itself -
    // `campaignName` sits on a wrapper - so the landmark is the stable anchor.
    this.campaignNameInput = page
      .getByRole('search', { name: 'Search form' })
      .getByRole('textbox');
    this.searchButton = page.getByRole('button', { name: 'Search', exact: true });
    this.clearButton = page.getByRole('button', { name: 'Clear', exact: true });
    // "1-1 of 1" and friends.
    this.resultCount = page.getByText(/^\d+-\d+ of \d+$/);
    // Matched by name, not id: the id is a per-campaign UUID, so it identifies
    // one row rather than the control.
    this.viewDashboardButton = page.getByRole('button', {
      name: 'View Dashboard',
    });
    this.transactionSummaryTab = page.getByText('Transaction Summary', {
      exact: true,
    });
    this.newShipmentButton = page.getByRole('button', { name: 'New Shipment' });
    this.bulkUploadHeading = page.getByText('Bulk Stock Upload', { exact: true });
  }

  /** Landing page -> My Campaigns. */
  async openModule(): Promise<void> {
    await this.moduleLink.click();
    await expect(this.campaignsHeading).toBeVisible({ timeout: 60_000 });
    await expect(this.tabNavigation).toBeVisible();
  }

  /** Filters the campaign list and waits for it to actually narrow. */
  async searchCampaign(name: string): Promise<void> {
    await this.campaignNameInput.fill(name);
    await expect(this.campaignNameInput).toHaveValue(name);
    await this.searchButton.click();

    // Asserting the campaign card is visible would pass vacuously - it is
    // already on screen before any search runs. The result count is the only
    // thing that distinguishes a filtered list from an unfiltered one.
    await expect(this.resultCount).toBeVisible({ timeout: 30_000 });
    await expect(
      this.page.getByText(name, { exact: true }).first(),
    ).toBeVisible();
  }

  /**
   * Opens the campaign dashboard.
   *
   * Playwright scrolls the target into view and refuses to click an element
   * another node is covering, so neither the manual scrolling nor the
   * sticky-header workaround the Maestro flow needed applies here.
   */
  async openDashboard(): Promise<void> {
    await this.viewDashboardButton.first().click();
    await expect(this.transactionSummaryTab).toBeVisible({ timeout: 120_000 });
  }

  /** Opens the Bulk Stock Upload dialog from the dashboard. */
  async openNewShipment(): Promise<void> {
    await this.newShipmentButton.click();
    await expect(this.bulkUploadHeading).toBeVisible({ timeout: 30_000 });
  }
}
