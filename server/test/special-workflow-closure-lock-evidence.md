# Closed-order recovery and SCM closure alerts — evidence

Spec: [special-workflow-closure-lock-spec.md](special-workflow-closure-lock-spec.md).
Spec approval: not obtained (autonomous run). Tier 3 because this completes an
already SCM-confirmed cancellation in NetSuite. The user also requested visible
SCM alerts and priority ordering for closure confirmations.

## Result

**SPREQ-000007 is cancelled locally, and both SOB121380 and POB03934 are Closed
in NetSuite.** The existing closure review
`337d40bf-597b-471d-a634-fc7ae0a8b82c` is approved. Both local canonical orders have
status `closed` and status text `Closed`. The original SCM confirmer was retained;
the operational retry was recorded without impersonating that operator.

The recovery made exactly one order mutation: REST PATCH
`/record/v1/purchaseOrder/1017168`, body
`{"item":{"items":[{"line":1,"isClosed":true}]}}`.
It did not write to the already closed SO. Complete line identities and raw
quantity/UOM/rate/description fingerprints matched before and after closure.
The final independent NetSuite status reads confirmed both orders Closed.
SPREQ-000006 business fingerprints matched before and after the operation; it
was not modified or retried.

SCM cards now show a closure confirmation/retry alert, with a visible queue count.
Those requests sort before adjustment reviews and ordinary cases, before server
pagination and after client updates. Confirmed or rejected closures lose their
alert and priority. Existing search and stage filters remain in effect.

## Cause and correction

Read-only diagnosis showed that the workflow lock belonged to the already closed
SO, whose three lines were closed and unexecuted/unbilled. Its REST GET failed;
the PO was still Pending Receipt and readable. The failed attempt had no saved
closure plan, so local cancellation had correctly stayed pending.

The closure adapter now recognizes that specific workflow-lock error and rereads
complete SuiteQL evidence. A terminal closed state, every line closed, zero
execution/billing, distinct exact line identities and valid commercial data are
required. An already closed order needs no further commercial edit. Its complete
expected item/line identities and unchanged raw query fingerprint are verified.
Open orders retain the full REST quantity/UOM/description checks before any write.
Capturing the raw fingerprint before closing permits safe locked readback without
guessing native UOM conversion. Reopened records conflict with a closed baseline.

No workflow was unlocked, disabled or edited. No RESTlet write or new script
upload was used. Diagnostic attempts to query the UnitsTypeUom table and read the
Units list were unavailable to this role; the final implementation requires
neither and uses the existing read-only transaction query fields instead.

## Executed verification

One final fresh run of `bash server/tools/special-workflow-closure-check.sh` passed:

- **281/281 related Special Item tests**, including real PostgreSQL closure
  approval/cancellation, duplicate confirmation, Dispatch guards, role privacy,
  partial writes, protected costs and ordering before pagination.
- Strict JavaScript type checks for the closure adapter, scoped lint, runtime
  and operational syntax, and the secret scan.
- **101/101 changed executable lines** and **79/87 measured changed-line branches**.
- **3/3 manual mutants killed** by the contract suite and independently by
  property-only runs: refusing locked-closed recovery, ignoring changed query
  evidence, and writing already closed lines. This is scoped manual mutation
  evidence, not an exhaustive mutation score.
- Focused tests in reversed order, plus real Chromium checks at **1440px and
  390px** verifying alert text, closure priority, confirmation/retry interaction,
  clearing completed alerts and restoring adjustment priority.

The first recovery run reproduced five failures on the deployed adapter. New UI
checks separately failed on the missing alert helper and wrong first result
before pagination. The only final-gauntlet interruption was an unused argument in
a test fixture; it was renamed without changing assertions. Type annotations were
completed before the final strict check. Runtime assertions were not weakened to
make tests pass. The spec's closed-record verification refinement is append-only
and explains why no native UOM conversion is inferred for terminal records.

Tool versions: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0. No dependency or migration was added, so dependency audit and
migration rollback were not applicable. Unrelated application regression was not
rerun. Existing dirty workspace changes were preserved; no commit was made.

## Deployment and reproduction

Both app and webhook worker run
`sha256:266610ffdaa1340ff3cde119e8b5026612aa92737cdf2af642c52711cddade58`.
Only the closure adapter, request repository, SCM script and shared case-status
module were overlaid on the prior verified image. Configuration and dependency
containers were preserved. Local/public health returned 200, and both browser
assets matched their deployed source hashes over both HTTP origins.

Final source manifest SHA-256:
`ade9b44f0b82e9697bfe0fcea22f97e3859d9c3e3570deab0bbbcef782062eb4`.

Raw tests, snapshots, coverage, browser screenshots, mutants, diff and source
manifest are under `server/test-artifacts/special-workflow-review/closure-lock/`.
The private `live/` directory holds the read-only diagnosis, recovery checkpoint,
exact successful write/result, protected-request result and HTTP verification.
Deployment/configuration/rollback artifacts are under
`server/test-artifacts/special-workflow-closure-lock-release-20260926/`.
Read-only release verification: `python3 server/tools/special-workflow-closure-deploy.py verify`.

Limits: NetSuite cannot be atomically locked together with the local database.
Fresh comparisons and the durable review journal retain conflict/retry protection.
Open-order workflow locks and unrelated REST failures still fail safely. Legacy
saved plans without a query fingerprint cannot use this fallback when their REST
record becomes unavailable; they require explicit reconciliation. The scoped
live correction targeted only SPREQ-000007's existing confirmation.
