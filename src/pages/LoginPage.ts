import { Page, Locator, expect } from '@playwright/test';
import { env } from '../utils/env';
import { byIdOrLabel } from '../utils/locators';

/**
 * The workbench-ui employee login form.
 *
 * Every field here gives its label and its input the same id, which is invalid
 * HTML and makes a bare `#id` locator ambiguous under Playwright's strict mode.
 * Narrowing by tag - `input[id="..."]` - picks the control rather than the
 * label, and is the direct equivalent of the `below: <label>` anchoring the
 * Maestro suite needed.
 */
export class LoginPage {
  readonly page: Page;
  readonly username: Locator;
  readonly password: Locator;
  readonly cityField: Locator;
  readonly privacyCheckbox: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.username = page.locator(
      'input[id="user-login-standalone-core_login_username-field"]',
    );
    this.password = page.locator(
      'input[id="user-login-standalone-core_login_password-field"]',
    );
    // Not the element carrying the city field's id - that one is the label
    // wrapper and it intercepts pointer events. The control that actually
    // opens the list is the dropdown button beside it.
    this.cityField = page.getByRole('button', { name: 'Select an option' });
    // Two elements carry this id - the checkbox itself and the "By clicking, I
    // accept the" label beside it. Continue stays disabled until it is ticked.
    this.privacyCheckbox = page
      .locator('[id="privacy-component-check"]')
      .first();
    this.submitButton = page.locator('[id="formcomposer-submit-action"]');
  }

  async goto(): Promise<void> {
    // The employee session lives in browser storage. Playwright gives each test
    // a fresh context, so there is no equivalent of Maestro's clearState here -
    // isolation is the default.
    await this.page.goto(env.url, { waitUntil: 'domcontentloaded' });
    await expect(this.username).toBeVisible({ timeout: 60_000 });
  }

  /**
   * Signs in. Defaults to the credentials in `.env`; the state-user flow passes
   * its own, which is why these are parameters rather than reads of `env`.
   */
  async login(
    userId: string = env.userId,
    password: string = env.password,
  ): Promise<void> {
    await this.username.fill(userId);
    await expect(this.username).toHaveValue(userId);

    // Deliberately not asserted the way the username is: this form exposes the
    // password value in the DOM, so asserting it would echo the secret into the
    // trace and the HTML report.
    await this.password.fill(password);

    await this.selectCity(env.city);

    await this.privacyCheckbox.click();

    // Continue is gated on the city AND the checkbox, both now supplied.
    await expect(this.submitButton).toBeEnabled();
    await this.submitButton.click();
  }

  /**
   * The option list renders on open, so selecting in the same breath as the
   * click races it. The tenant name is also the heading of the login card, so
   * the option has to be scoped to the open list or the match lands on the
   * heading and the form submits with no city set.
   *
   * Public because Continue is gated on the city as well as the privacy
   * checkbox, so the negative login cases need to set it independently of
   * login() to isolate which input is actually doing the gating.
   */
  async selectCity(city: string): Promise<void> {
    await this.cityField.click();

    const dropdown = this.page.locator('[id="jk-dropdown-unique"]');
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    await dropdown.getByText(city, { exact: true }).click();
  }

  /** Signs in and waits for the landing page to finish rendering. */
  async loginAndWait(userId?: string, password?: string): Promise<void> {
    await this.goto();
    await this.login(userId, password);

    // Sign-in round-trips the employee's tenant and role set before rendering,
    // so this is the slow step. Waiting on the landing content itself rather
    // than on the form disappearing, which passes vacuously in the gap.
    await expect(byIdOrLabel(this.page, 'Landing page content')).toBeVisible({
      timeout: 120_000,
    });
  }
}
