# Prompt playbook: building this suite one flow at a time

This is not a description of this repo — `testcases.md` covers that. This is
the set of prompts to hand an AI coding assistant, **in order**, to build a
Playwright suite like this one for an HCM Commodity Management-style module:
several user roles reaching the same underlying dialog through different
setup, at least one role writing real records to a live environment. It was
written by extracting the pattern from actually doing this once, covering a
**national/supplier** user and a **state/warehouse** user.

Reuse it by copying one stage's prompt block, filling in the brackets, pasting
it to a fresh or ongoing session, checking the result, then moving to the next
stage. Don't paste all stages at once — each stage's findings (a quirk, a
gating rule, a safety need discovered against the real app) are exactly what
the next stage's prompt should already account for, and an assistant asked to
do everything up front has nothing to account for yet.

---

## 0. Gather this before writing any prompt

You, not the assistant, should be able to answer these before Stage 1:

- **Module and environment.** Name of the module, URL(s), and whether an
  existing automation suite already covers part of it (carry its selectors and
  hard-won app knowledge forward instead of rediscovering them).
- **Every user role that reaches the feature**, and what is structurally
  different about each one's path through it. For this project: a
  **national/supplier** user ships from an effectively-infinite source to one
  chosen destination; a **state/warehouse** user ships from a real warehouse
  the dialog pre-selects, down a multi-level destination cascade, in a
  quantity bounded by that warehouse's live stock. Your project's roles will
  differ, but write down the equivalent axis of difference for each one now —
  it drives which parts of Stage 3 onward can be shared and which can't.
- **Does any flow write to a real/production system?** If yes: what should the
  kill switch be (an env var, compared as an exact string, defaulting to
  *off*), and what would a duplicate write look like if a test retried itself?
- **Whether you're prepared for a passing run to actually write real data.**
  Decide this now, not mid-session — Stage 6 asks the assistant to confirm
  with you before a run that could submit, and you should already have an
  answer ready.

---

## Stage 1 — scaffold

```
Build a Playwright + TypeScript test suite covering [MODULE NAME] in
[APPLICATION]. [One sentence on why Playwright rather than whatever automation
this replaces or supplements, e.g. "the existing Maestro suite cannot upload a
file; Playwright does it in one line with setInputFiles."]

Stack: @playwright/test, TypeScript, @types/node. Chromium only unless told
otherwise. Any library the flow itself needs (e.g. a spreadsheet library if
the flow downloads/uploads Excel).

Layout:
  src/pages/   one page-object class per screen/dialog
  src/utils/   env.ts (typed config), plus whatever the flow needs
  tests/       specs
  artifacts/   downloads, screenshots, report, traces (gitignored)

Page-object model: locators as readonly fields set in the constructor, action
methods that assert their own post-condition before returning rather than
just performing the click/fill.

Config entirely via .env, nothing hardcoded. Write .env.example (committed,
documented) and gitignore .env. src/utils/env.ts is the only place that
touches process.env; a missing required key throws immediately with a useful
message rather than letting a blank/undefined value get typed into a form
silently. Validate anything numeric as the type it actually needs to be (e.g.
non-negative integers for a quantity).

[If a flow writes to a real/production system, include this verbatim:]
This suite can write to production. Build these guards in from the start, not
after the first accidental write:
  1. An exact-string opt-in env var (e.g. HCM_ALLOW_SUBMIT === 'true') gates
     every submit-equivalent action. Unset, empty, "1", "yes", "TRUE" must all
     read as *not authorised* - the dangerous direction is never the default.
     When gated off, everything up to and including the last safe step still
     runs, and the test asserts the submit control *became enabled* instead of
     clicking it - full coverage of the hard part, zero writes.
  2. retries: 0 in the config - a retry would re-submit and duplicate records.
  3. workers: 1, fullyParallel: false - parallel workers would race the same
     shared resource (campaign/record/queue).
  4. forbidOnly: true.
Also set realistic timeouts: this kind of enterprise app's sign-in and
dashboard aggregation are commonly much slower than Playwright's 30s/5min
defaults - raise both if a first run times out on nothing but load. Set trace/
screenshot/video to retain-on-failure so a failure is diagnosable without
re-running a flow that writes.
```

---

## Stage 2 — first flow (national/supplier), happy path

```
Build the happy-path spec for the [ROLE 1 NAME] flow: [one-line description of
the steps, e.g. "login -> open the module -> find the campaign -> open the
dashboard -> New Shipment -> select state + destination facility -> download
the stock template -> fill quantities -> upload -> submit -> verify the
result list"].

One test, not several, if login is the slowest step in the journey - Playwright
gives every test a fresh browser context, so splitting stages into separate
tests means paying for sign-in more than once for no benefit. Structure the one
test as named test.step()s instead, so a failure still reports which stage
broke.

Name the spec and its page objects with a role prefix from the start (e.g.
`nat-*`) even though it's the only flow that exists yet - a second role's flow
is coming in a later stage, and retrofitting the prefix onto files and CI
commands after the fact is pure churn.

Assertion discipline - don't write assertions that pass vacuously:
  - After any list/search action, assert something that only a real result
    produces (a result count, a specific value appearing) - not that a
    container element is present, because it may already be on screen before
    anything happens.
  - After sign-in, wait for the destination page's actual content, not for the
    login form merely disappearing (there can be a gap where neither is true).
  - When a control becomes enabled only once several inputs are supplied,
    prove it via the control's own state, not via a side-effect that clears
    on a subset of those inputs (e.g. a validation warning that tracks only
    one of the required fields).
  - If the flow fills a downloaded file and re-uploads it, read the values
    back off disk afterward and assert them, rather than trusting the writer
    function that produced them.
  - If the target writes asynchronously (a dialog that closes immediately while
    a batch job creates records afterward), poll for the batch's own completion
    signal - a dialog-closed-only assertion passes while the batch is still at
    0 processed, and would go green even if every record then failed.
  - Never assert a secret's value (e.g. a password field) even though the
    library made you fill it - it echoes into the trace and HTML report.

If the flow hands out a file to fill in and re-upload (a spreadsheet, a CSV):
find columns by header name, not position, so a future column reorder can't
silently write into the wrong field. Trim incoming strings. Respect the file's
own stated rules about hidden rows/columns exactly. Write output to a new file
rather than overwriting the download, and throw rather than silently writing
zero rows.
```

---

## Stage 3 — first flow, negative cases

```
Build negative-case coverage for the [ROLE 1 NAME] flow, in a separate spec
file from the happy path. Nothing in this file may call the real submit
action - it must be safe to run against production regardless of the
submit-gating env var.

Group cases into tiers by setup cost, and organise the file that way:
  1. Pure-function cases against the flow's own data-writing/validating
     utilities (e.g. the spreadsheet filler) - no browser at all. Assert the
     diagnosis in the thrown error, not just that something threw, so a future
     reader can tell which malformed input is being protected against.
  2. Login-failure cases - each one needs a login that does NOT succeed, so
     these can't share a session with each other. For a gate driven by
     multiple required inputs (e.g. Continue disabled until both a checkbox
     and a dropdown are set), fill everything except the input under test,
     assert the gate is shut, THEN supply the missing input and assert the
     gate opens. Asserting only "gate is shut" proves nothing about which
     input was responsible. Never test a wrong password against a real
     account - lockout risk; a nonexistent username proves the same thing.
  3. Dialog/form cases - one shared login via a serial describe block, cases
     build on each other's state in order rather than each resetting from
     scratch, since resetting means paying for the setup again.

While building these, actively try to break gating logic: what's disabled
before anything is filled, what stays disabled with only some of several
required inputs set, what happens on a wrong file type vs a right file type
with wrong internal content. If you find the app accepting something it
should reject, do not delete the finding or invert the assertion to match the
bug - mark the case as an expected failure (Playwright: test.fail()) with a
comment explaining what was observed and when. An expected failure that starts
passing is Playwright's own signal that the bug got fixed.

If the flow hands out a file with a part it says must never be touched (a
hidden row, a locked cell, an ID column): don't only build synthetic fixtures
from scratch to test content validation - also download the REAL file once,
corrupt only that one protected part with a real writer function (leaving
everything else, including a legitimately-filled quantity, exactly as a valid
upload would have it), and upload that. A synthetic fixture proves the app
rejects an invented shape; a tampered real file proves it rejects real data
with one specific real thing wrong, which is a different and often more
revealing question - three of this project's four confirmed content-validation
defects were only found this way, not via synthetic fixtures.

Test config-loading failure the same rigor applies to, not just UI gating: if
config is read at module *import* time (fail-fast on a missing key), that
failure path is unreachable from inside the same process once any spec has
already imported it successfully with a complete environment - Node caches
modules. Spawn a genuinely separate process instead: copy the current
process's own already-complete environment, delete just the one key under
test, and run the compiled module in that fresh process. If the config module
has no imports of its own, compiling it is cheap and dependency-free via the
TypeScript compiler API directly (`ts.transpileModule`) rather than shelling
out to `npx tsc` - a subprocess call with its own cross-platform PATH problems
- or adding a whole new dependency like ts-node just for this.
```

---

## Stage 4 — second flow (state/warehouse), happy path

```
Build the happy-path spec for the [ROLE 2 NAME] flow, reusing everything from
[ROLE 1 NAME]'s flow that is genuinely the same underlying app component, and
building new page-object surface only for what's structurally different.

For this project the difference was: [describe it concretely, e.g. "the
source is pre-selected by the dialog rather than chosen, so it's asserted
rather than clicked; the destination is a 3-level cascade (LGA -> Ward ->
Facility) instead of one pick, where every level shares the same DOM id and
must be addressed positionally, confirmed via its own chip after each pick;
and the quantity shipped is not a constant - it's min(desired, live balance),
read off a summary screen at run time, because a warehouse can run out and a
supplier can't"]. Name the new spec and page objects with this role's prefix
(e.g. `state-*`), extending the first role's page-object base class for
whatever really is shared (the base class's own doc comment should say so
explicitly, so the next reader doesn't have to diff two files to find out).

If a value has to be read from a live dashboard/summary before it can be used
(a balance, a count, anything that "settles" after an async load): don't trust
a single read. If the same read can plausibly return a self-consistent but
wrong value while data is still loading (e.g. a running total that is
correctly computed from only half the components that feed it), require
several stable reads in a row before trusting it, and give up with a clear
error - naming what the impossible/inconsistent shape looked like - if it
never stabilises. A single sleep-then-read is a slower guess at the same
problem, not a fix for it.

If the flow now goes through a dialog reached only after other floors of the
same page have been polling/fetching, add a deliberate settle before opening
it - opening a data-dependent dialog into live background traffic is exactly
when its own fetch races and comes back empty.

Whatever safety gate Stage 1 built (e.g. HCM_ALLOW_SUBMIT) still applies. If
this role's write is also conditioned on live data being favourable (e.g.
"skip the write entirely if the bounded quantity worked out to zero"), that's
a second, independent gate - state and check both explicitly, and log via a
test annotation which gate (if either) caused the write to be skipped.
```

---

## Stage 5 — second flow, negative cases

```
Build negative-case coverage for the [ROLE 2 NAME] flow, in its own spec file
- not appended to [ROLE 1 NAME]'s negative spec, and not merged into one file
"to save a login". A separate file earns its keep here: this role's dialog has
gating behaviour ([e.g. "a pre-selected source, a 3-level cascade"]) that has
zero coverage anywhere else, and unlike the happy-path page objects, negative
cases don't benefit much from being co-located.

Do NOT re-test what's genuinely shared and role-agnostic: a template-filling
utility that doesn't know which role called it, or a login function that takes
credentials as parameters rather than hardcoding a role's own - re-running
those under a second role's credentials exercises the identical code path and
adds a comment's worth of value at a full test's worth of cost. Say so in the
spec's own top comment, so a future reader doesn't "fix" the perceived gap by
duplicating them.

DO test what's new: for a multi-level cascade, verify each level renders only
once its parent is set (not before), and that the ultimate submit-enabling
control stays disabled through every partial state of the cascade, only
becoming enabled once the last level is actually picked - not merely once a
warning message clears, if the warning and the real gate turn out to track
different conditions (check this against the real app; don't assume they're
the same signal).

If a bug found in Stage 3 lives in a component this role's dialog shares with
Stage 3's, expect it to reproduce here too and write the case to check - don't
skip it as "already covered elsewhere". If it does reproduce, mark it
test.fail() and cross-reference the same finding from Stage 3, so it reads as
one defect observed twice, not two defects.

If you find yourself wanting to test what happens when a user removes/changes
an earlier step in an already-completed multi-step selection (e.g. clearing
the first level of a cascade after finishing all of them): weigh the cost (if
the underlying fetch that populates any of these levels is itself slow or
known-flaky, re-establishing the selection doubles this file's exposure to
that flakiness) against the fact that this is exactly the kind of case where
guessing the outcome is tempting and wrong. Don't assume clearing an ancestor
level cascades down to reset its children just because the *forward* direction
is documented as hierarchical ("each level renders only once its parent is
set") - the reverse is a separate code path the app may not have implemented
symmetrically. If you do skip it for cost, say so explicitly rather than
silently assuming the symmetric behaviour holds; if you do write it, assert
what you can verify actually happens (does the control that gates the real
write go back to disabled?), not what seems like it should happen. One
project's version of this case found a real defect - clearing the top level
left the lower levels selected and the write-gating control still enabled -
purely because the case was written to check rather than assume.

If this role's flow has a live-data-bounded quantity (Stage 4's
min(desired, balance) pattern): test what happens when the *uploaded* quantity
exceeds that live balance, using the real downloaded template filled with
balance + a small margin (small on purpose - a huge margin only proves the app
rejects the absurd, not that it actually checks against real stock). This
needs the real balance, so this file's own setup may need to read it before
opening the dialog too, same order as Stage 4. Never click submit to find out
what a rejection looks like server-side - that risks writing the exact invalid
record the case exists to prevent. If uploading is enough to observe the
result (the control that gates the real write stays disabled, or doesn't),
that's sufficient; if a widget replaces itself once a file is accepted (a drop
zone becoming a filename-plus-remove card, say), add a cleanup step - in a
finally block, so it runs whether the assertion passed or (as expected) threw
- that undoes it, or every case after this one in the same serial file inherits
a dialog that no longer looks like the one they were written against.
```

---

## Stage 6 — run for real, fix issues

```
Run [SPEC FILE] against [ENVIRONMENT]. If it fails, diagnose before touching
any assertion:
  - Is this a stale test value (config pointing at a facility/record/id that
    no longer exists or moved), or a genuine app defect, or a genuine bug in
    the test's own locators/timing? Use a throwaway diagnostic script/spec
    (never committed) to check the app's actual current state independently
    before assuming any of the three - e.g. does the value the config expects
    still exist at all, does it exist somewhere else, does selecting it
    reproduce the same failure a moment later.
  - If a check searches text/elements across the whole page rather than
    scoped to the dialog/component under test, treat that as a suspect first:
    anything already visible in the background (a list, a table, a previous
    result) can produce a false match and either mask a real failure or
    misreport what was actually offered. Scope it to the component.
  - If the app has a known-intermittent step (a fetch that sometimes returns
    empty and needs a fresh request rather than a longer wait), and it failed
    more times in a row than the retry budget allows for, that's a signal to
    widen the retry budget and the surrounding test timeout to match - not to
    weaken the assertion that's catching it.

Before re-running anything that could reach a real write (see Stage 1's
guards): confirm with me first if the run might actually write, even if the
safety env var is already set to allow it. Being configured to allow a write
is not the same as me having decided *this specific run* should perform one -
ask, don't assume the standing config is today's answer too.

If a live dependency needed to observe some behaviour is down or unusually
flaky - not just the occasional retry, but failing far more than the retry
budget expects, repeatedly, across many separate attempts - don't keep
retrying at a fixed short interval indefinitely; a live system having a bad
window doesn't recover faster because it's asked more often, and re-running
the exact same steps back to back tends to find the exact same failure back to
back. Tell me the failure rate observed (e.g. "8 of the last 9 attempts") and
ask how to proceed rather than silently grinding. If I say to keep trying,
prefer real spaced-out gaps between attempts over rapid-fire ones, and prefer
running each attempt directly and visibly over wrapping it in another
background/monitoring layer you haven't already proven works in this
environment - a wrapper that itself behaves unexpectedly (produces no output,
or output you can't account for) is a second problem stacked on the first, and
debugging it costs more than just running the thing again yourself would have.
If a case still can't be verified after reasonable effort, don't invent the
missing behaviour to unblock yourself - offer to write the case against the
minimal safety property that must hold regardless of exact wording (e.g. "the
control that gates the real write stays disabled" rather than a guessed error
string), record what's actually observed via a test annotation, and say
explicitly that it's provisional pending confirmation. The moment a real run
does get through, don't leave the provisional version in place - rewrite it as
a concrete assertion against what was actually observed (a confirmed
test.fail() defect, or a real passing check), the same discipline as Stage 3's
"don't invent, don't skip, don't leave a placeholder wearing a passing test's
clothes."

If a one-off submit investigation (see above) finds that clicking the real
write control does *nothing at all* - no success signal, no error, no record
created - don't stop at the first confirmation and generalise from it. Try it
again with a DIFFERENT kind of input, including at least one that the app's
own stated rules say is actually valid (a boundary value like zero, not just
another invalid one). If the silent-nothing outcome reproduces for the valid
input too, that changes the finding: it is no longer "validation is missing
but the failure mode is at least safe," it is "the write control appears
broadly unreliable outside the one exact shape already proven to work,"
which is a different and often more urgent thing to tell whoever owns the
app - report it as such, separately from the missing-validation finding, not
folded into it.
```

---

## Stage 7 — keep the docs in sync

```
Update [a test-case index file, e.g. testcases.md] to reflect what this
session added or changed: new spec files, new case IDs (keep a stable
ID-per-case scheme, e.g. one prefix per role plus a tier letter, so a case can
be referenced without pasting its title), the current total test count split
by positive/negative, which cases write to the environment and under what
conditions, and any newly confirmed defect with the date it was observed and
which case(s) pin it. Do this in the same change as the spec edit, not as
follow-up housekeeping - a stale index is worse than none, because it's
trusted by default.
```

---

## Standing principles

Restate these to a fresh assistant session if you're resuming mid-project
rather than running the stages back to back in one sitting:

- **One test per costly-login flow.** Every extra test is another sign-in if
  sign-in can't be skipped; keep a whole journey in one test with named steps
  instead of splitting it for "test isolation" that isn't actually free here.
- **Page objects assert their own post-conditions.** An action method
  shouldn't just perform a click - it should wait for the thing that click was
  supposed to cause, so a caller never has to remember to check.
- **Scope locators to the component under test**, not the whole page, whenever
  the rest of the page could plausibly contain matching text/elements already.
- **Retry a flaky async fetch by re-issuing the request, not by waiting
  longer**, once you've confirmed empirically (against the real app) that
  waiting longer doesn't help.
- **Never invert or delete a finding to make a suite go green.** Pin a
  confirmed defect as an expected failure with a comment, so fixing the app
  is what turns the suite green, not editing the test.
- **Config is 100% env-driven, fails loud on a missing key**, and any
  role-specific config that not every user of the suite will have set (e.g. a
  second role added later) should fail lazily (on first read) rather than at
  import time, so it doesn't break every other spec that never needed it.
- **A standing "allow the dangerous action" config value is not the same as
  today's authorisation to actually trigger it.** Ask before a run that could
  write, even when it's configured to be allowed to.
- **A live system having a bad window doesn't recover faster because you ask
  more often.** If a dependency needed to verify a case is failing well beyond
  its normal flakiness, say so with numbers and ask how to proceed, rather than
  retrying indefinitely at a fixed short interval or quietly guessing at the
  behaviour you couldn't observe.
