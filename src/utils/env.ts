/**
 * Typed access to the values in .env.
 *
 * Everything reads through here rather than touching process.env directly, so a
 * missing key fails immediately with a useful message instead of Playwright
 * typing the string "undefined" into the login form.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function requiredInt(name: string): number {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a whole number of 0 or greater, got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

export const env = {
  url: required('HCM_WEB_URL'),
  userId: required('HCM_WEB_USER_ID'),
  password: required('HCM_WEB_PASSWORD'),
  city: required('HCM_WEB_CITY'),
  campaignName: required('HCM_CAMPAIGN_NAME'),
  toFacility: required('HCM_TO_FACILITY'),
  spaq1: requiredInt('HCM_SPAQ1'),
  spaq2: requiredInt('HCM_SPAQ2'),

  /**
   * Submit writes real stock records. Deliberately an exact string comparison:
   * anything other than "true" - unset, empty, "1", "yes", "TRUE" - reads as
   * not authorised, so the dangerous direction is never the default.
   */
  allowSubmit: process.env.HCM_ALLOW_SUBMIT === 'true',

  /** True when pointed at a host that is not obviously a UAT environment. */
  get isProduction(): boolean {
    return !/uat|staging|qa|dev/i.test(this.url);
  },
};

/**
 * Config for the state-user flow, which ships from a warehouse down a
 * LGA -> Ward -> Health Facility hierarchy rather than from a supplier.
 *
 * Getters, not plain properties, on purpose: `env` above is evaluated the
 * moment this module is imported, so making these eager would break every
 * existing spec for anyone whose .env predates these keys. As getters they
 * only throw when the state spec actually reads them.
 */
export const stateEnv = {
  get userId(): string {
    return required('HCM_STATE_USER_ID');
  },
  get password(): string {
    return required('HCM_STATE_PASSWORD');
  },
  /** Source warehouse, exactly as the radio label renders it. */
  get fromFacility(): string {
    return required('HCM_STATE_FROM_FACILITY');
  },
  get lga(): string {
    return required('HCM_STATE_LGA');
  },
  get ward(): string {
    return required('HCM_STATE_WARD');
  },
  /** Destination, with its code: "ba Lamba Health Post (F-...)". */
  get toFacility(): string {
    return required('HCM_STATE_TO_FACILITY');
  },
  /**
   * The same destination without the code. The Health Facility dropdown lists
   * the bare name while the checkbox beneath carries the code, so both spellings
   * are needed from the one configured value.
   */
  get toFacilityName(): string {
    return this.toFacility.replace(/\s*\(.*\)$/, '').trim();
  },
};
