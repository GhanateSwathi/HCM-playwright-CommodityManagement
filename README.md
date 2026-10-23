# hcm-playwright

Playwright/TypeScript coverage for the HCM workbench-ui **Commodity Management**
module, including the **Bulk Stock Upload** flow.

This project exists for one reason: Maestro cannot upload a file. The sibling
`hcm-web-automation` repo covers login, campaign search and the dashboard
perfectly well, but its `MAESTRO-LIMITATIONS.md` records four separate
techniques that all failed to get a file into this dialog. Playwright does it in
one line — `locator.setInputFiles(path)`.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env    # then fill in credentials
```

Requires Node 18+. Node 22 and npm 11 are what this was built against. Unlike
Maestro, there is no JDK requirement at all.

## Running

```bash
npm test                 # headless
npm run test:headed      # watch it
npm run test:debug       # Playwright inspector
npm run report           # open the HTML report
npm run test:ui          # pick what to run, interactively
```

## ⚠️ This suite writes to production

`HCM_WEB_URL` points at **Bauchi production**. `new-shipment.spec.ts` submits a
real stock shipment and creates real transaction records.

Three guards are in place:

1. **`HCM_ALLOW_SUBMIT`** must be exactly the string `true` or the Submit step is
   skipped. Everything up to and including the upload still runs, and the test
   asserts Submit became enabled — so you get full coverage of the hard part
   without writing anything.
2. **`retries: 0`** — a retry would re-submit the shipment and duplicate records.
3. **`workers: 1`, `fullyParallel: false`** — parallel workers would race the same
   campaign.

With `HCM_ALLOW_SUBMIT` unset or `false` the run is read-only and safe against
production whenever you like: the upload — the hard part, and the reason this
project exists — still runs in full, and only the Submit click is withheld.

## Tests

| Spec | Writes? | Covers |
|---|---|---|
| `new-shipment.spec.ts` | **yes, if allowed** | login → module → campaign → dashboard → Bulk Stock Upload → state + facility → download template → fill SPAQ 1/2 → upload → Submit → wait for the batch to finish → verify the Transaction List |
| `negativecases.spec.ts` | **never** | template-writer error messages (no browser), the Continue gates on the login form, and the dialog refusing a non-spreadsheet or a workbook with no `Stock Data` sheet |

`negativecases.spec.ts` never calls `submit()`, so it is safe to run against
production whatever `HCM_ALLOW_SUBMIT` is set to:

```bash
npx playwright test tests/negativecases.spec.ts
```

The happy-path spec is one test on purpose:

It is one test on purpose. Playwright gives every test a fresh browser context,
so splitting this in two would mean signing in twice, and sign-in is the slowest
step in the journey. Keeping it whole means **one login per run** — and the
Transaction List gets checked on the very dashboard the shipment was submitted
from, rather than navigating back to it.

## Layout

```
playwright.config.ts   runner config: timeouts, the safety guards, artifacts
tsconfig.json          typecheck only; nothing here is compiled by tsc
src/pages/             LoginPage, CommodityPage, BulkStockUploadPage
src/utils/             env.ts (typed config), stockTemplate.ts (exceljs), locators.ts
tests/                 the spec
artifacts/             downloads, filled templates, screenshots, report, traces (gitignored)
PROMPT.md              build prompt that would regenerate this suite from scratch
.claude/               hook that reminds you to keep PROMPT.md in step
```

## Code walkthrough

Page-object model throughout: locators are `readonly` fields declared in the
constructor, actions are methods that assert their own post-condition before
returning. So a method that comes back successfully has already proved the app
reached the state it claims.

### `playwright.config.ts`

Loads `.env` through `dotenv` before anything else, then sets:

- **`timeout: 5min`, `expect.timeout: 30s`.** Sign-in round-trips the employee's
  tenant and role set before the landing page renders, and the commodity
  dashboard aggregates warehouse data server-side. Both are slow enough that
  Playwright's 30s default is not workable.
- **`retries: 0`.** Not a preference — a retry would re-submit the shipment and
  duplicate real records.
- **`workers: 1`, `fullyParallel: false`.** Parallel workers would race the same
  campaign.
- **`forbidOnly: true`.** Refuses to run at all if someone leaves a `.only` in
  the spec, which would otherwise silently shrink the suite.
- **`trace`/`screenshot`/`video: retain-on-failure`.** Everything needed to work
  out what happened without re-running a flow that writes to production.
- **`headless: process.env.HEADED !== '1'`**, so `HEADED=1` is enough to watch a
  run without touching the config.
- **`ignoreHTTPSErrors`** is not needed for the real host; it is there so a
  proxied or UAT host with a self-signed certificate needs no config change.

### `tsconfig.json`

Worth knowing that **`tsc` is never run by `npm test`** — Playwright transpiles
the spec with esbuild and does not typecheck. This file governs what your editor
underlines, so run `npx tsc --noEmit` yourself before trusting a green run.

`module: CommonJS` is load-bearing: the config and the spec both use `__dirname`,
which does not exist in ESM. `esModuleInterop` is what allows the default imports
of CommonJS packages (`path`, `dotenv`, `exceljs`). `strict: true` is what forced
the explicit `undefined` handling in `stockTemplate.ts` rather than a crash
mid-upload. The `@pages/*` and `@utils/*` path aliases are currently declared but
unused — every import in the project is relative.

### `src/utils/env.ts`

The only place that touches `process.env`. `required()` throws immediately with a
useful message if a key is missing, so a typo in `.env` fails fast instead of
letting Playwright type the string `"undefined"` into the login form.
`requiredInt()` additionally rejects anything that is not a whole number of 0 or
greater.

`allowSubmit` is a **deliberately exact** string comparison against `"true"`:
unset, empty, `1`, `yes` and `TRUE` all read as *not authorised*, so the
dangerous direction is never the default. `isProduction` reports whether the URL
looks like a non-UAT host.

### `src/utils/locators.ts`

One function, `byIdOrLabel`, matching `[id="…"], [aria-label="…"]` and returning
`.first()`. The Maestro suite reported both attributes as a single "resource-id",
so the inherited selectors are a mix: machine-looking ones like `campaignName`
really are ids, while human-readable ones like `Landing page content` are
`aria-label`s. Rather than guess per selector, it tries both. `.first()` is there
because an element can legitimately carry the same value in *both* attributes,
which would otherwise trip strict mode.

### `src/utils/stockTemplate.ts`

Fills the downloaded workbook, obeying the rules its own ReadMe sheet sets (see
[The stock template](#the-stock-template) below). Three things to know:

- `columnIndexByHeader()` finds columns **by header text, trimmed** — several
  strings in this app carry trailing spaces — and on failure throws listing the
  headers it *did* find, which turns a template change from a mystery into a
  one-line diagnosis.
- Facility rows start at **row 3**, because row 2 is hidden and holds
  product-variant IDs. Rows with a blank `To (Facility Code)` are skipped rather
  than filled with stray quantities, and zero filled rows is an error.
- The original download is left untouched; the result is written to a separate
  `Stock_Template_filled.xlsx`, so a failed run cannot corrupt the source and the
  two can be diffed.

`readStockQuantities()` exists purely so the spec can read the quantities back
off disk and assert them, instead of trusting the writer it just called.

### `src/pages/LoginPage.ts`

Every field on this form gives its label and its input the same id, which is
invalid HTML and makes a bare `#id` ambiguous under strict mode — hence
`input[id="…"]` to pick the control. The city field's id sits on a label wrapper
that intercepts clicks, so the real control is the adjacent
`getByRole('button', { name: 'Select an option' })`; the option list renders on
open, so `selectCity()` waits for the dropdown and scopes the option to it (the
tenant name is also the login card's heading, and an unscoped match lands there
and submits with no city set).

Note what is deliberately *not* asserted: the username's value is checked after
filling, the **password's is not**. This form exposes the password in the DOM, so
asserting it would echo the secret into the trace and the HTML report.

`loginAndWait()` waits on the landing page's content rather than the form
disappearing, which would pass vacuously in the gap between the two.

### `src/pages/CommodityPage.ts`

Navigation from the landing page to the campaign dashboard. "Commodity
Management" appears twice on the landing page — as a card heading and as a link —
and the role filter separates them cleanly, since the heading is not a button.

`campaignNameInput` anchors on the `search` landmark because the control itself
has no usable id (`campaignName` sits on a wrapper). `viewDashboardButton` matches
by name rather than id, because that id is a per-campaign UUID and so identifies
one row rather than the control.

`searchCampaign()` asserts the **result count** (`1-1 of 1` and friends), not that
the campaign card is visible — the card is already on screen before any search
runs, so asserting it would pass whether the filter worked or not.

### `src/pages/BulkStockUploadPage.ts`

The dialog itself, and the reason the project exists.

`exact: true` appears on every role lookup in here for a specific reason: the
whole modal is wrapped in a `div role="button"` whose accessible name is the
concatenation of all its text, so a substring match resolves to both the wrapper
and the real control and trips strict mode.

- `selectState()` ticks the state, then **clicks an inert label to close the
  dropdown**. That close is load-bearing, not cosmetic: the destination facility
  list only renders once the dropdown collapses, and clicking the multi-select
  again just reopens it.
- `selectDestinationFacility()` proves both selections registered by watching the
  `Please select hierarchy level first` warning disappear and Download become
  enabled.
- `downloadTemplate()` uses `waitForEvent('download')` so Playwright intercepts
  the file rather than letting it land in the OS download folder — no guessing at
  Chrome's ` (2)` suffix.
- `uploadTemplate()` is the one line Maestro could not do at all:
  `setInputFiles()` drives the real `input[type=file]` behind the drop zone, so
  the zone never needs scrolling into view. It then waits for **Submit to become
  enabled**, which is the component's own signal that it accepted and parsed the
  sheet.
- `submit()` clicks. That is all it does — everything about *what happens next*
  lives in the spec, because the outcome is asynchronous.

### `tests/new-shipment.spec.ts`

One test, in named `test.step`s, so a failure report names the stage that broke.
Why one test rather than several is covered under [Tests](#tests) above.

The interesting part is the submit step. The dialog closes immediately on submit,
but the records are created afterwards by a batch job, and the dashboard reports
`Creating batch 1 of 1... N/M records processed | K failed`. So the step polls
until the processed count catches up with the total — the regex backreference
`^(\d+)\/\1 records processed` is what makes `2/2` pass and `0/2` not — and then
asserts `0 failed`. Without that, the test would go green while the batch was
still at `0/2`, even if every record subsequently failed.

The final step checks the Transaction List on the same dashboard. It asserts the
columns and that rows exist, and records the row count as an annotation rather
than asserting it grew: against live data a new record does not reliably sort
onto page 1. The batch assertion above is what proves the records were created.

### `.claude/`

`hooks/prompt-md-reminder.mjs`, wired up in `settings.json` as a `PostToolUse`
hook, prints a reminder whenever `src/**`, `tests/**`, `playwright.config.ts`,
`.env.example` or `package.json` changes — because `PROMPT.md` is derived from
those, and a stale build prompt is worse than none. The hook only reminds; it
cannot regenerate the prose.

## The stock template

The dialog hands out an `.xlsx` whose `Stock Data` sheet has one row per selected
destination facility. Its own ReadMe sheet sets the rules, and
`src/utils/stockTemplate.ts` respects them:

- only the product quantity columns are written
- **row 2 is hidden and holds product-variant IDs** — never touched
- rows and columns are never added, removed or reordered
- quantities are whole numbers, 0 or greater

Columns are found **by header name**, not by position, so a column reorder in a
future template version does not silently write into the wrong product. Note the
headers carry a space: `SPAQ 1`, not `SPAQ1`.

## App quirks worth knowing

These cost real time to find. Most are inherited from the Maestro work.

- **The whole upload modal is a `div role="button"`** whose accessible name is
  the concatenation of every string inside it. Any `getByRole('button', {name})`
  in that dialog without `exact: true` matches both the wrapper and the real
  control, and trips strict mode.
- **The destination facility list only renders once the State dropdown closes.**
  Clicking the multi-select again just reopens it, so an inert label is used to
  dismiss it.
- **Upload validation checks the file type, not the workbook.** A plain `.txt`
  is rejected and Submit stays disabled, but a valid `.xlsx` containing no
  `Stock Data` sheet is accepted with no error shown and Submit becomes enabled.
  Observed 2026-09-23 against Bauchi; pinned by a `test.fail()` case in
  `negativecases.spec.ts`, so the suite will report it the day it is fixed. What
  the backend does with such a file is unknown — finding out means submitting.
- **The hierarchy warning and the Download gate are not the same condition.**
  `Please select hierarchy level first` clears as soon as the state is picked,
  but Download stays disabled until a destination facility is ticked too. The
  warning disappearing is not evidence the dialog is ready — only the button
  state is. `negativecases.spec.ts` pins this down.
- **Duplicate ids.** Login fields give the label and the input the same id.
  `input[id="..."]` picks the control; a bare `#id` is ambiguous.
- **The city dropdown's id is on a label wrapper that intercepts clicks.** The
  real control is `getByRole('button', { name: 'Select an option' })`.
- **The campaign search box has no usable id** — `campaignName` sits on a
  wrapper. Anchor on the `search` landmark: `getByRole('search', { name: 'Search
  form' }).getByRole('textbox')`.
- **Human-readable "ids" are often `aria-label`s.** `src/utils/locators.ts`
  matches either.
- **Submitting is asynchronous.** The dialog closes immediately, then a batch job
  creates the records and the dashboard reports
  `Creating batch 1 of 1... N/M records processed | K failed`. Asserting only
  that the dialog closed passes while the batch is still at `0/2` — it would go
  green even if every record then failed. The spec waits for the processed count
  to catch up with the total and asserts `0 failed`.

## What Playwright made unnecessary

Compared with the Maestro flow, all of this simply stopped being a problem:
manual scrolling before every interaction, the sticky-header workaround for taps
landing on the wrong element, coordinate swipes to scroll inside the modal, and
the two-phase orchestration that download-then-fill-then-upload would otherwise
need. Playwright auto-scrolls, refuses to click an obscured element, and can
capture the download and drive the file input inside a single test.

It is also faster: the same journey runs in about 20 seconds against roughly 80
in Maestro.
