# SN1400333 receiving correction

## Result and scope

The failed request already targeted **POB03658**, NetSuite internal ID **936958**.
It omitted the memo and included five fully received source lines as
`itemReceive:false`. This is the likely reason for NetSuite's static-sublist 400;
an actual successful transform has **not** been demonstrated.

### Clarification after the user's split-line correction

The five completed lines **are not part of SN1400333**. A fresh read of the
active split ledger confirms that SN1400333 has only these four source lines:

| Split item | Stable source line key | Parent REST orderLine | Split quantity |
| --- | --- | --- | --- |
| UNI-TV80S-RDM-PLAT | 4725002 | 15 | 1305.6 |
| UNI-TV60T-RDM-PLAT | 4725005 | 18 | 629.46 |
| UNI-TV60S-1224-STORM | 4725010 | 23 | 930 |
| PALLET | 4725025 | 38 | 32 |

The source resolver returns all 39 parent PO lines as `availableLines`, and the
draft builder iterates that list. It selected the four split lines correctly
and added the other 35 parent lines as `itemReceive:false`. The five completed
lines came from that parent list. They were never selected for receipt, and the
prepared correction does not remove any of the split's four lines.

Explicit deselection is intended to prevent receipt of other parent lines.
The verified facts are the four-line split and the expanded 39-line request;
the hypothesis that the five completed parent lines triggered the 400 remains
unproven. Earlier conversational wording did not clearly distinguish parent
lines from split lines and overstated the certainty of the diagnosis.

The two-file correction carries the stored receiving reference into the IR memo
and omits source lines with an authoritative remaining quantity of zero. It
retains reconciliation evidence and explicitly deselects every other open line.
Conflicting shipment references cannot share one receipt. Existing fulfillment,
quantity caps, source resolution and duplicate-recovery behavior are retained.

Oracle documents [creating an Item Receipt by transforming its source purchase
order](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0817102411.html).
The stored request and read-only replay, rather than the shipment's displayed
name, establish which PO this application actually used.

**Deployed on 2026-09-15 at 23:46 UTC under the user's explicit authorization.**
App and worker are healthy, and a read-only check of the deployed code produced
the expected PO, memo and four selected quantities. No receipt, retry, local
completion, or failed-command repair was submitted. See the
[deployment report](sn1400333-receiving-deployment.md).

- [Specification](sn1400333-receiving-spec.md): Tier 3; spec approval not obtained
  (autonomous run). Independent specification review did not occur.
- [Task-only runtime patch](sn1400333-receiving.changes.patch).
- Git base: `c82c71d6632ffef21ff0a77c3dabbce542f805e2`; prior worktree edits preserved.
- Exact before/after hashes and reversible blocks:
  [change manifest](sn1400333-receiving-changes.json).
- No dependency, schema, endpoint, or UI changes. Deployment replaced only the
  two tested backend files in the app and worker images.

## Read-only production replay

Final read at **2026-09-15 23:07:35 UTC**, using the finished runtime files and
the running app's existing configuration mounted read-only. Database work used
`REPEATABLE READ, READ ONLY`. The executable never calls the posting service,
transform adapter or finalizer.

| Field | Observed result |
| --- | --- |
| Source PO | POB03658 / 936958 |
| Receipt memo | SN1400333 |
| Original / corrected payload lines | 39 / 34 |
| Completed lines omitted | 9, 16, 20, 29, 37 |
| Selected quantities | 15:1305.6; 18:629.46; 23:930; 38:32 |
| Selected locations | 1 on all four lines |
| Failed command | Remains failed |
| Receipt under failed request's external ID | None found |

Selected quantities exactly matched the stored failed request. Line 63 retains
its original nonsequential identity. Raw corrected payload:
`test-artifacts/sn1400333-receiving/live-read-only.json`.

An external-ID lookup does not rule out receipts posted manually or under other
request IDs. Source reads are not atomic with a later transform; closed lines,
subsequent PO changes and NetSuite customizations remain live acceptance limits.

## Specification to tests

New scenarios are in `test/mbt/unit/sn1400333-receiving.test.js`:

| Scenario | Verification |
| --- | --- |
| 1: positive parent, stored shipment memo, exact selected lines | Real lineage/live-source/target/domain/adapter chain with mocked database and remote boundaries; read-only production replay |
| 2: omit completed lines, retain open deselections and line 63 | Exact 34-line payload assertion; generated mixed receipts |
| 3: reconciliation, remaining caps, unknown quantities, unchanged IF | Completed and partially completed selections; existing domain and allocation properties; explicit SO/TO IF regression |
| 4: memo hash, aggregation, conflicts and omission | Hash comparison, conflict rejection, blank/identical memo cases, missing stored reference |
| 5: invariant and compatibility checks | 160 seeded generated PO/TO receipt cases; existing posting/receiving tests; seven deliberate faults |

## Final focused verification

| Layer | Result |
| --- | --- |
| Focused tests | **66 passed, 0 failed** |
| New tests | **9 passed** |
| Full suite | **485 files; 2,475 tests; 2,472 passed, 2 existing failures, 1 skipped** |
| Pre-change full-suite baseline | **484 files; 2,466 tests; 2,463 passed, 2 existing failures, 1 skipped** |
| New full-suite failures / cancelled tests | **0 / 0** |
| Shuffled suite | **66 passed**; seed 1400333, eight separate file invocations |
| Changed-line coverage | **16/16** mapped changed lines executed |
| Branch coverage on changed lines | **15/15** reported c8 branch counters executed |
| Mutation tests | **7/7** plausible faults caught |
| Property-only mutation run | **3/3** applicable generated-input faults caught |
| New generated property | **160 cases**, seed 1400333 |
| Static types | **233 baseline / 233 final** existing diagnostics; zero new |
| ESLint | **0 errors, 0 warnings** in changed runtime, test and JS tools |
| Secret scan / capability review | No findings in checked files; runtime adds no new network, file or process capability |
| Shell / Python tools | Shell syntax and Python compilation passed |
| Dependency audit | Not applicable: dependency set unchanged |
| UI and schema testing | Not applicable: neither changed |
| Actual NetSuite write | Unverified: no live receipt authorized or submitted |

Completed full-suite comparison and source verification are recorded in
`test-artifacts/sn1400333-receiving/verified-results.json`. The two unchanged
failures are `P3.12: browser specs share one worker-owned database-pool lifecycle`
and `quality non-regression: the gauntlet builds and validates the omit-dev runtime`.

## Reproduce

From `server/`, with the existing Docker test image and PostgreSQL image:

```sh
sudo -n bash tools/sn1400333-receiving-gauntlet.sh
```

This reconstructs pre-change runtime from the manifest, runs both full suites
on fresh isolated databases, runs the focused/static/coverage/mutation checks,
and verifies that current sources match the reported hashes. Package versions
are pinned in `package.json`; execution used Node **20.20.2**, c8 **12.0.0**,
fast-check **4.9.0**, ESLint **10.8.0**, and TypeScript **7.0.2** in
`mbbs-retired-confirm-test:20260914`.

The production read-only replay is separately executable, with existing access:

```sh
sudo -n bash tools/sn1400333-receiving-live.sh
```

It asserts this incident's observed state and will intentionally stop if a later
receipt, PO change or operator edit changes that state. No write fallback exists.

## Issues found during verification

- The first RED run had seven assertion/property failures and one passing
  compatibility regression. The latter was subsequently validated by mutations
  that dropped unknown quantities or changed fulfillment deselections.
- An initial full-suite baseline snapshot omitted migrations. That run was
  stopped, retained as invalid, and replaced with a complete migrated snapshot;
  none of its failures count as baseline failures.
- An initially incorrect adapter test filename stopped collection; the runner
  was corrected to use the existing runtime-adapter test.
- The first standalone live replay lacked the app's M2M settings and returned
  `invalid_grant`. Mounting the existing application data read-only fixed it;
  the final replay succeeded without changing credentials.
- Lint detected extra complexity in the target resolver. A small memo helper
  was extracted under passing tests; final lint passes.
- A completed-line mutant initially survived the property-only run because
  uniformly random quantities rarely hit zero. Explicitly weighting zero fixed
  the input-generation gap without weakening assertions. The final property
  suite kills it and the other two applicable mutants.
- The test-order check uses separate processes because Node sorts multi-file
  arguments. Final seeded ordering is actually enforced.

## After deployment

The failed command's immutable payload is retained. A database read confirmed its
order claim is inactive, released at **2026-09-15 22:18:49 UTC**. The correction
is now deployed. Reopen the receiving confirmation to obtain a new request ID
and build a fresh payload.
Replaying the old request ID retains the original failed request semantics.
The investigation did not change business records; the authorized deployment
subsequently updated the app and worker images.
