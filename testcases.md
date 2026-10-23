# Test cases

Every case in the suite, what it proves, and whether it writes to the target
environment. Derived from `tests/nat-new-shipment.spec.ts`,
`tests/nat-negativecases.spec.ts`, `tests/state-new-shipment.spec.ts`,
`tests/state-negativecases.spec.ts` and `tests/env-config.spec.ts` — update it
when any of the five changes.

Naming convention: `nat-*` is the **supplier** flow (source is an
effectively-infinite supplier, destination is one facility). `state-*` is the
**warehouse** flow (source is a real warehouse the dialog pre-selects,
destination is three levels deep — LGA → Ward → Health Facility — and the
quantity shipped is bounded by that warehouse's actual stock).

| | |
|---|---|
| Total | 30 tests (2 positive, 28 negative/config) |
| Writes to the environment | 2 (`POS-01`, `SPOS-01`) — both only when `HCM_ALLOW_SUBMIT=true`; `SPOS-01` additionally only when there is stock to ship |
| Known defects pinned | 5 (`NEG-D04`, `NEG-D05`, `SNEG-D06`, `SNEG-D08`, `SNEG-D10`) |
| One-off findings (not automated — see below) | 3, all pointing at the same underlying issue: Submit gives no feedback for non-happy-path input |
| Last full run | 2026-09-30 against Bauchi |

```bash
npx playwright test                                    # everything (POS-01, SPOS-01 may write)
npx playwright test tests/nat-negativecases.spec.ts     # supplier negative only, never writes
npx playwright test tests/state-negativecases.spec.ts   # state negative only, never writes
npx playwright test tests/env-config.spec.ts            # config only, no browser, never writes
npx playwright test tests/state-new-shipment.spec.ts    # state positive only, may write
```

---

## Positive — `nat-new-shipment.spec.ts`

One test, deliberately: each Playwright test gets a fresh context, so splitting
it would mean signing in more than once. The steps below are stages of `POS-01`,
not separate tests — a failure at any stage fails the whole case.

### `POS-01` — bulk stock upload, end to end

**Writes: yes**, if `HCM_ALLOW_SUBMIT` is exactly `true`. Otherwise every stage
below runs except the Submit click, and the case asserts Submit *became*
enabled instead.

| # | Stage | What it proves |
|---|---|---|
| 1 | Sign in | Credentials + city + privacy accepted; the landing page content renders (not merely that the form vanished) |
| 2 | Open campaign dashboard | Module opens, campaign search narrows the list — asserted via the result count, since the card is on screen before any search |
| 3 | Open Bulk Stock Upload | New Shipment opens the dialog |
| 4 | Select state + destination facility | Both registered, proven by Download becoming enabled |
| 5 | Download the stock template | The browser download is intercepted and saved; the `.xlsx` arrives |
| 5a | Fill SPAQ 1 / SPAQ 2 | Columns located by header name; at least one facility row written |
| 5b | Read the quantities back off disk | The values really landed — verifies the writer rather than trusting it |
| 6 | Upload the filled template | `setInputFiles` drives the real file input; Submit becomes enabled, which is the app's own signal it parsed the sheet |
| 7 | Submit | Dialog closes, **and** the batch reports processed-count catching up with the total with `0 failed` — a dialog-closed-only assertion would pass at `0/2` |
| 8 | Verify the Transaction List | Columns `TRN`, `Sent from`, `Sent to`, `Status`, `Quantity` render and rows exist, on the same dashboard, no second login |

---

## Positive — `state-new-shipment.spec.ts`

Also one test, same reasoning as `POS-01`. The stages differ from the supplier
flow in three ways that matter: the source warehouse is asserted rather than
selected (the dialog pre-picks it for this user), the destination is a
three-level cascade instead of one facility, and **the quantity is not a
constant** — it is `min(HCM_SPAQn, balance)` read off Stock Summary at run
time, because a real warehouse can run out and a supplier cannot.

### `SPOS-01` — state user bulk stock upload: State CMS down to a health facility

**Writes: yes**, if `HCM_ALLOW_SUBMIT` is exactly `true` **and** at least one of
the two SPAQ balances is positive. Two independent gates, not one: the second
exists because shipping more than a warehouse holds, or shipping from a
warehouse whose balance is already negative, would create records that should
not exist regardless of what `HCM_ALLOW_SUBMIT` says. If either gate is closed,
every stage below still runs except the Submit click, and the case asserts
Submit *became* enabled instead.

| # | Stage | What it proves |
|---|---|---|
| 1 | Sign in as the state user | Same as `POS-01` step 1, with `stateEnv` credentials |
| 2 | Open campaign dashboard | Same as `POS-01` step 2 |
| 3 | Read SPAQ 1 / SPAQ 2 balances off Stock Summary | Figures held stable across repeated reads (a half-loaded card is internally consistent but wrong — see `stockSummary.ts`) before either is trusted |
| 4 | Let the dashboard settle, then open Bulk Stock Upload | Opening the dialog while the dashboard is still fetching is when the destination facility list is most likely to come back empty |
| 5 | Confirm the source warehouse | **Asserted, not clicked** — the radio arrives pre-checked; clicking it would hide a regression in which the app stopped pre-selecting it |
| 6 | Narrow LGA → Ward → Health Facility | Each level confirmed by its own chip; the Health Facility pick retries (re-picking, not waiting longer) if the boundary fetch behind the facility list comes back empty — see `PROMPT.md`'s Stage 6 and `StateBulkStockUploadPage` quirk #3 |
| 7 | Download and fill the stock template | Quantity written is `min(desired, balance)` for each product, **not** a hardcoded constant |
| 7a | Read the quantities back off disk | Same non-vacuous check as `POS-01` step 5b |
| 8 | Upload the filled template | Same as `POS-01` step 6 |
| 9 | Submit | Same batch-progress assertion as `POS-01` step 7, when both gates are open |
| 10 | Verify the Transaction List | Same as `POS-01` step 8 |

---

## Config — `env-config.spec.ts`

No browser at all — spawns real, separate Node processes to test what a
single in-process test cannot: `env.ts` reads `process.env` at module *import*
time, and by the time any other spec has run, it has already been imported
once with a complete environment, so the failure path is unreachable from
inside that same process. Each case here compiles `env.ts` once (via the
TypeScript compiler API, in-process — no shelling out to `npx tsc`, which is
its own source of cross-platform PATH problems) and runs the result in a
fresh child process whose environment is copied from this one, minus whichever
key is under test.

| ID | Case | Expected |
|---|---|---|
| `CFG-01` | `HCM_WEB_URL` unset, everything else present | Import throws immediately: `HCM_WEB_URL is not set. Copy .env.example to .env and fill it in.` |
| `CFG-02` | `HCM_SPAQ1` set to `"not-a-number"` | Import throws: `HCM_SPAQ1 must be a whole number of 0 or greater, got "not-a-number"` — not silently coerced to `NaN` or `0` |
| `CFG-03` | Every `HCM_STATE_*` key unset | **Import succeeds** (`env.url` is readable) — `stateEnv` fields are getters specifically so a project with no state-user config yet doesn't break every other spec. Only *reading* `stateEnv.userId` throws, with the same "not set" message |

---

## Negative — `nat-negativecases.spec.ts`

**None of these write.** `submit()` is never called, so the whole file is safe
against production whatever `HCM_ALLOW_SUBMIT` is set to.

### Tier 1 — stock template writer (no browser launched)

Pure function calls against deliberately malformed workbooks built at runtime.
Each asserts the *diagnosis*, not just that something threw. Shared with the
state flow — `fillStockTemplate` does not know or care which dialog called it —
so these are **not** repeated in `state-negativecases.spec.ts`.

| ID | Case | Expected |
|---|---|---|
| `NEG-T01` | Quantity is not a whole number (`1.5`) | Throws `spaq1 must be a whole number of 0 or greater, got 1.5` |
| `NEG-T02` | Quantity is negative (`-1`) | Throws `spaq2 must be a whole number of 0 or greater, got -1` |
| `NEG-T03` | Workbook has no `Stock Data` sheet | Throws **naming the sheets it did find**, so a renamed sheet is diagnosable |
| `NEG-T04` | `Stock Data` exists but `SPAQ 1` column is missing | Throws **listing the headers present** — the guard against a silent column rename or reorder |
| `NEG-T05` | Headers present but no facility rows | Throws `No facility rows found to fill`. Writing nothing and reporting success would mean an empty upload that looked fine |

### Tier 2 — login form

Each case needs a login that does *not* succeed, so a shared session is
impossible here by definition. Also shared with the state flow — `LoginPage.login()`
is exactly the same code path for `stateEnv` credentials as for `env`'s — so
these are **not** repeated in `state-negativecases.spec.ts` either.

| ID | Case | Expected |
|---|---|---|
| `NEG-L01` | Username, password and city set; privacy checkbox **not** ticked | Continue disabled — then ticking it enables Continue, which is what proves the checkbox was the gate |
| `NEG-L02` | Username, password and checkbox set; Country/State/City **not** selected | Continue disabled — then selecting the city enables it |
| `NEG-L03` | A username that does not exist, everything else valid | Continue is reachable and clicked; the landing page never renders and the login form is still shown |

`NEG-L01` and `NEG-L02` each supply the missing input afterwards on purpose.
Asserting only that Continue is disabled would pass for *any* missing field —
an earlier version of this file did exactly that and "proved" the checkbox gate
while the city was also unset.

A wrong password against the real account is deliberately **not** tested:
repeated failures risk locking it out, and `NEG-L03` establishes the same thing.

### Tier 3 — Bulk Stock Upload dialog (supplier)

Serial, sharing one page, so this whole tier costs one login. Order matters —
each case builds on the dialog state the previous one left.

| ID | Case | Expected |
|---|---|---|
| `NEG-D01` | Dialog just opened, nothing selected | `Please select hierarchy level first` shown; Download and Submit both disabled |
| `NEG-D02` | Only the state selected | Download **still** disabled. The hierarchy warning has already cleared — it tracks the state, not the facility, so its absence is not evidence the dialog is ready |
| `NEG-D03` | Upload a plain `.txt` file | Rejected: Submit stays disabled through a 5s settle |
| `NEG-D04` | Upload a real, validly-filled template whose hidden row 2 (product-variant IDs) has been overwritten | **Should** be rejected. **Currently is not** — see Known defects |
| `NEG-D05` | Upload a valid `.xlsx` with no `Stock Data` sheet | **Should** be rejected. **Currently is not** — see Known defects |
| `NEG-D06` | Click Back | Dialog closes and no batch banner appears — nothing was submitted |

`NEG-D04` downloads the real template (rather than building one from scratch,
like every other case in this tier) specifically so the tampered row 2 is a
real corruption of real data, not an invented shape — the only cell touched is
the one the template's own ReadMe sheet says must never be touched.

---

## Negative — `state-negativecases.spec.ts`

**None of these write** either, for the same reason: `submit()` is never
called. One `describe.serial` tier only — the template-writer and login tiers
above are not repeated, since neither cares which flow called it.

Also serial and cumulative, and for an extra reason beyond cost: the state
cascade's boundary fetch is slow and occasionally needs retries (see the state
positive case, stage 6), so walking it more than once per file would make this
file both slower and more exposed to that flake. Since `SNEG-D08` needs the
real, live SPAQ 1/2 balances to construct an over-balance quantity, this file's
own `beforeAll` reads Stock Summary before opening the dialog — the same
order, and the same reason, as the positive case's stage 3.

### Tier — state Bulk Stock Upload dialog

| ID | Case | Expected |
|---|---|---|
| `SNEG-D01` | Dialog just opened, nothing selected | Source warehouse radio arrives **pre-checked** (asserted, not clicked); Download and Submit both disabled |
| `SNEG-D02` | Still nothing selected | Only the LGA cascade level exists — Ward and Health Facility must not render before their parent level is set |
| `SNEG-D03` | Only the LGA picked | Ward now exists, Health Facility still does not; Download stays disabled |
| `SNEG-D04` | LGA + Ward picked, no facility ticked | Health Facility now exists; Download stays disabled |
| `SNEG-D05` | A Health Facility ticked | Download becomes enabled — the precondition for the upload cases |
| `SNEG-D06` | The LGA chip is removed (Ward + Health Facility left untouched) | Cascade **should** collapse to 1 level and Download **should** go back to disabled. **Neither happens** — see Known defects |
| `SNEG-D07` | Re-pick the same LGA | Download becomes enabled again — restores a working selection for every case after this one, cheaper than clearing and re-walking the whole cascade |
| `SNEG-D08` | Upload a real template filled with balance + 50 for both products | **Should** be rejected. **Currently is not** — see Known defects |
| `SNEG-D09` | Upload a plain `.txt` file | Rejected: Submit stays disabled through a 5s settle |
| `SNEG-D10` | Upload a valid `.xlsx` with no `Stock Data` sheet | **Should** be rejected. **Currently is not** — see Known defects |
| `SNEG-D11` | Click Back | Dialog closes and no batch banner appears — nothing was submitted |

`SNEG-D01`–`SNEG-D08` have no equivalent in `nat-negativecases.spec.ts`: the
supplier dialog has no pre-selected source, no cascade, and no live balance to
exceed, so `NEG-D01`/`NEG-D02` cover a single hierarchy warning where the state
file's first eight cover four cascade states, a cascade-consistency defect, its
recovery, and a quantity check that only makes sense against a real warehouse.

`SNEG-D08` deliberately uploads via `dialog.fileInput.setInputFiles` rather
than the shared `uploadTemplate()` helper, and cleans up afterward: once a file
is accepted, the drop zone is replaced by a filename + Download/Delete card,
and the plain `input[type=file]` locator stops resolving the same way. The
case clicks Delete in a `finally` block — regardless of whether its own
assertion passed or (as expected) threw — specifically so `SNEG-D09` gets a
working input back.

`SNEG-D06`/`D07` were originally left out of this file for cost — clearing a
chip and re-establishing the selection means walking the slow, sometimes-
retried boundary fetch a second time in the same file. Added back in because
the cost turned out to buy a real finding, not just reassurance.

---

## Known defects

### Upload accepts invalid file content — one shared root cause, four symptoms

The shared Upload/Submit component (`BulkStockUploadPage`, used by both
dialogs) validates a file's *type* but not its *content* in any way that has
been found. Four different kinds of invalid content have each been tried, and
all four are **accepted with no error shown, and Submit becomes enabled**:

| ID | Spec | What was wrong with the file |
|---|---|---|
| `NEG-D05` | `nat-negativecases.spec.ts` | Valid `.xlsx`, sheet not named `Stock Data` (observed 2026-09-23) |
| `SNEG-D10` | `state-negativecases.spec.ts` | Same defect, reproduced in the state dialog (2026-09-24) |
| `NEG-D04` | `nat-negativecases.spec.ts` | Otherwise-valid, validly-filled template with the hidden product-variant-ID row (row 2) overwritten (confirmed 2026-09-28) |
| `SNEG-D08` | `state-negativecases.spec.ts` | Otherwise-valid template, quantity 50 over the live warehouse balance (confirmed 2026-09-25) |

`NEG-D03` / `SNEG-D09` each prove a plain `.txt` *is* rejected, so whatever
validation exists is checking the file extension/MIME type and stopping
there — it never opens the workbook to check the sheet name, the hidden row,
or the requested quantity against anything. Worth asking the app team whether
this is one gap (no content validation at all) rather than fixing each
symptom separately.

All four marked `test.fail()` rather than deleted or inverted: inverting would
bless the behaviour, deleting would lose the finding. Playwright treats an
unexpected *pass* as a failure, so the day content validation is added, all
four suites report it and all four annotations can be removed together.

### Cascade does not reset when an ancestor selection is cleared (state dialog only)

Confirmed 2026-09-29 against Bauchi. Removing the LGA chip clears LGA's own
dropdown, but Ward (`Lanzai West`) and Health Facility (`ba Lamba Health
Post`) both keep their previous selections, the cascade still renders all 3
levels, and **Download stays enabled** — confirmed by actually downloading a
real template in that exact state, which succeeded and produced a file still
addressed to `ba Lamba Health Post` despite no LGA being selected at all. A
user who removes their LGA to pick a different one, changes their mind, or
misclicks has no visible signal that the destination they are about to ship to
no longer has a selected LGA behind it.

This is a different *kind* of defect from the four above — a cascade/UI
consistency gap, not a missing content check — so it is not assumed to share
the same root cause.

| ID | Spec |
|---|---|
| `SNEG-D06` | `state-negativecases.spec.ts` |

### Submit gives no feedback for non-happy-path input — three one-off findings, not automated

Each of the four content defects above, and this cascade defect, stop at
Upload on purpose and never click Submit, because doing so risks writing the
exact invalid record the case exists to catch. Three follow-up questions were
investigated once each, deliberately, outside the routine suite, with explicit
go-ahead:

| Date | Flow | What was submitted | Balances/context |
|---|---|---|---|
| 2026-09-28 | state | Quantity balance + 1 (169,201 / 868,650) | Balances at the time: 169,200 / 868,649 |
| 2026-09-30 | supplier (nat) | Quantity exactly 0 for both products — an **explicitly valid** value per the template's own rules | n/a — supplier has no balance limit |
| 2026-09-30 | supplier (nat) | The known-bad wrong-sheet-name workbook | n/a |

**All three produced the identical outcome**: Submit was enabled and clicked
exactly once; the dialog never closed; no batch-progress banner ever
appeared; no error or warning showed anywhere on screen; Submit stayed
enabled and clickable, as if nothing had happened. Read-only follow-up checks
(reload the dashboard, re-read the Transaction List and, for the state case,
Stock Summary) confirmed **no new record was created and no balance
changed** in any of the three cases — the transaction count was identical
before and after every attempt.

This widens the finding beyond "data integrity holds despite broken
validation": the middle row is an **explicitly valid input** (zero is
allowed by the template's own ReadMe), and it produced the same silent
failure as the two invalid ones. That suggests Submit itself may be fragile
for a broad range of inputs that simply differ from the one exact shape
already proven to work (`POS-01`/`SPOS-01`'s positive quantities), not
specifically defensive against bad data. Worth treating as a separate,
possibly higher-priority question for the app team from the content-validation
gap above: *why does Submit silently do nothing outside the happy path,
including for at least one input its own rules say is fine?*

Not added as a permanent automated case in either negative-cases file:
both are documented and relied upon as never calling `submit()` at all (see
each file's own top comment), and a submit-clicking case — even one confirmed
to currently no-op safely — would break that guarantee for the next reader and
would need re-verifying by hand every time the app changes, not by routine CI.

Three attempts on 2026-09-28 to reach the state-flow submit investigation
failed before Submit — one infrastructure hang, two hits of the intermittent
boundary fetch (`PROMPT.md`'s Stage 6 covers the resulting playbook addition)
— consistent with the bursty pattern documented there; a fourth attempt on a
later day got through cleanly.

---

## Not covered

Stated so the gaps are known rather than assumed away. Substantially shorter
than before — everything reasonably coverable without an unpredictable write
now has been:

- **What the backend does with genuinely malformed content on Submit**, beyond
  the three one-off findings above. Those three cover over-balance, zero-qty,
  and wrong-sheet-name; a tampered hidden row and a cleared-cascade Submit
  remain unexplored, and each further one-off costs real investigation time
  for a result that (based on the pattern above) is likely to be the same
  silent no-op.
- **Error-message text on a failed upload or login.** No error state has ever
  been observed in either app flow, even after the Submit investigations above
  — there is nothing to assert. The cases assert control state instead.
- **A wrong password for a real account** — deliberate, permanent policy, not
  a coverage gap: repeated failures risk locking out a real account, and
  `NEG-L03` establishes the same gate a different way.
- **A boundary combination with genuinely zero facilities**, i.e. verifying the
  app's own `No facilities found for the selected boundary` message on a
  boundary that is *supposed* to be empty rather than one that intermittently
  fails to load. No such boundary is known to be safe to assert against.
- **Multiple destination facilities**, in either flow. `nat-*` uses the single
  facility in `HCM_TO_FACILITY`; `state-*` uses the single LGA/Ward/facility in
  `HCM_STATE_LGA` / `HCM_STATE_WARD` / `HCM_STATE_TO_FACILITY`. Deliberately
  deferred: it needs new env config and page-object changes, and touches the
  already-verified core happy-path specs — a separate, larger task rather than
  incremental coverage.
- **Any browser but Chromium**, and any viewport but 1600×1000 — explicit
  project scope decision (see `PROMPT.md` Stage 1), not an oversight.
