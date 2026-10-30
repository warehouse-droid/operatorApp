# Whole-quote decisions and Team parts receiving — 2026-10-29

Tier 3: financial decisions, receipt replay and a targeted historical correction.
Specification: `test/repair/spec.md`, criteria 65–68. Spec approval: not obtained
(autonomous run). No dependencies, commits or schema changes.

## Acceptance and failure-model mapping

| Behavior / failure mode | Executable evidence |
| --- | --- |
| Control, Repair and customer links offer Accept quote / Reject quote for the whole quote, with an optional shared reason | `whole-quote-receiving.test.js`, three-screen browser case; updated Control/Office purchasing and original approval browser workflows |
| Older clients cannot submit mixed line decisions; validation rolls back without saving a command | Mixed-decision HTTP case; seeded uniform/mixed decision property; mixed-decision mutant also run against the property alone |
| Rejected jobs resolve as declined and disappear from the Team list and a stale direct link | Rejection/parent-receipt case, browser selection case, missing-completion/list/selection mutants |
| Other jobs, approvals, Office history, the single request receipt and the unrepaired equipment hold survive | Two-job quote cases, original scope/replay/receipt suites and fleet-block properties |
| Tapping a Team purchase request opens only its linked PO lines and ETAs; waiting-for-PO requests have no receipt form | Request-linked receiving browser case and incoming-parts API assertion |
| Partial receipts and multiple POs conserve stock; a lost response cannot receive twice or create a Bill | Browser receives 0.5 then remaining quantities across two POs, deliberately loses the first successful response and retries; verifies exactly 3 units in stock and no Bill intents |
| Phone and tablet operation remain usable | Receiving browser checks at 390×844 and 820×1180, no horizontal overflow; both generated previews visually inspected before automatic cleanup |
| Historical correction requires administrative authority and the exact active mixed quote; rejects downstream work, parts usage, purchases and non-inspection posting | Administrative correction, replay/audit and three downstream guard cases; unsafe-correction mutant |
| Requester privacy, purchasing approval, receiving authority, invoice-before-Bill and shared portal behavior remain | Existing requester/assignment/property, purchase/browser, affected regression and shared-shell suites |

## Reproduction

From `server`, run the complete captured-candidate checks:

```sh
sudo -n python3 tools/repair-whole-quote-release.py validate
```

The entry point uses the repository's bounded disposable runner. Source snapshots,
the scoped patch and individual hashes are operational release records under the
host's latest-five-copy retention policy. No Git checkpoint was created; captured
hashes identify the source independently of other workspace work.

`tools/repair-whole-quote-correction.mjs` is an explicit operational command for
the authorized REP-0000002-J02 quote. It is executed as stdin inside the deployed
app, with `--apply` required for mutation; its import paths are relative to `/app`.
The maintenance repository method has no public HTTP route. The command preserves
the old line decisions in an event and records before/after snapshots. It does
not approve another quote, purchase parts, grant authority or call NetSuite.

## Corrections during validation

The initial six acceptance tests failed before implementation: mixed decisions
were accepted, whole-quote payloads were unsupported, the property found a mixed
counterexample, the correction method was absent, the UI had per-line selectors,
and incoming lines lacked their purchase-request identifier. The missing-method
failure is weaker evidence than the behavioral assertion failures in the other
cases. The final guard cases and explicit fault checks exercise that method.

Positive partial-approval tests were replaced by explicit rejection of mixed
decisions, as requested. Declined-job cases now assert automatic resolution and
retain inspection notes/hours recorded before rejection. Authority, amounts,
scope, stock, replay and receipt assertions remain. Test-only declaration/window
qualifications resolved lint errors without changing assertions.

The first complete run passed all 150 tests in normal, coverage and reversed
orders, then stopped at an old Team draft-loss mutation hook moved by the new
receiving-dialog reset. The hook was updated to inject the same draft-loss fault.
Its three Team faults and all five Control faults were then caught in an isolated
precheck. The final complete run follows that tooling correction.

A later combined run again passed the functional, coverage, order and existing
fault checks, but stopped in the new mutation group. That group passed from a
fresh disposable database. Its harness now resets disposable fixtures before
each baseline/mutant and requires the unmodified test to pass before crediting a
fault detection. This removes dependency on earlier groups and guards against
crediting an unrelated fixture failure. A concurrent production release is
preserved by capturing and rebasing the scoped candidate before final validation.

The new unmodified baseline exposed the specific setup defect: mutation copies
contained only `public/repair`, omitting the shared Operator CSS and sidebar used
by the PWA/Office shells. Thus a failed browser test alone was insufficient to
credit a mutation. The new, Control, requester-PWA and Office-purchase mutation
copies now include all captured public assets and require an unmodified baseline
before mutation, with disposable fixtures reset between them. Earlier mutation
counts without those baselines are not used as final evidence for this release.

The Control browser checks mount the actual approval module in a minimal Control
toolbar host with the real repository/API; they do not claim a manual authenticated
session through every Control feature. Live HTML/asset hashes and shared-shell
checks cover the integration boundaries. No live NetSuite financial write is
used for validation.

The user subsequently requested the data be updated directly. The guarded
operational `direct-data-correction.mjs` transaction was applied to J02 before
the UI cutover, using the existing production job-save/parent-rollup code. Both
lines are rejected; J02 is completed with a declined outcome and quote_rejected
phase. The existing rejection reason is retained. The transaction verified other
jobs, other quotes and posting settings were byte-for-byte unchanged, and saved
the old lines/job/request in the database audit event. Its before/after record is
`deployments/repair-whole-quote-20261029/direct-data-correction.json`.
The direct correction does not call the new maintenance API method; that method
was exercised separately with synthetic data in the isolated tests.

Temporary mutation source copies are now removed in a per-case `finally` block,
including on failures, instead of accumulating until the outer teardown. Test
limits were not raised. The final combined run completed successfully with this
cleanup and the positive browser baselines; intermediate failures are not counted
as successful mutation evidence.

## Final fresh results and cutover

The final complete run followed the last implementation/tooling change:

- Repair normal, coverage and reversed-order runs: **150/150 passed each**.
- Related regression tests: **40/40 passed** across nine isolated files.
- Shared login/menu/notification browser checks: passed.
- Changed instrumented backend/shared-domain lines: **24/24 covered**: domain 3,
  purchasing 1, quotes 19, repository 1. Browser assets are exercised in Chromium.
- Overall instrumented statements/lines: **93.57%**; branches: **83.97%**. Full
  branch coverage is not claimed.
- Manual mutation cases: **50/50 caught**, including all seven new whole-quote,
  filtering, receipt mapping/retry and correction faults. Five selected mutants
  were also caught by properties alone. The Control, PWA, Office purchase and
  new mutation cases require successful unmodified baselines before mutation.
- ESLint, TypeScript shared-domain checking, server syntax and secret scan:
  passed. No new dependencies required an audit or license change.
- Unchanged baseline: `S11: the guarded client ships in a new atomic Driver shell
  generation`; the other three Driver asset-contract checks passed. No new
  failures were accepted.

Tools: Node 20.20.2, ESLint 10.8.0, TypeScript 7.0.2, c8 12.0.0,
fast-check 4.9.0, Playwright 1.62.1.

Repair tree hash:
`d4280e1086443cbe5533d428ae2b77258166658ba5b75cfe533bc59847c9109a`.
Integration hash:
`4b98d1685ec2a0ca8ab82901db27327c8aebdc7ec9a0ace42b7df3039270e617`.

The scoped release preserves the independent Driver inactivation deployment.
Deployed **16:38:25 UTC**, image `mbbs-operator-app:repair-whole-quote-20261029`,
ID `sha256:5ea905350a69a648413f7a56d218f4060303b9bd3b682ed69b824595fd957643`.
All **29 scoped file hashes** and **30 local/public HTTP checks** passed.
Application configuration and the other production services were preserved;
no migration was required. A rollback image remains available.

The direct J02 correction committed at **16:07:33 UTC**. The post-deployment
read-only audit confirmed both quote lines rejected with their original reason,
J02 completed/declined and absent from the Repair Team list, exactly one correction
audit event, and J01 still queued with its approved quote. The correction's own
transaction verified J01 and other quotes unchanged. NetSuite posting remains
disabled; no live PO or NetSuite financial write was performed.

After final teardown, both `docker ps` and `docker ps -a` were checked: no Repair
test containers remain, and no Repair disposable volumes, networks or runner
artifact directories remain. All raw test logs, screenshots, coverage and mutation
copies were removed. An independently active `mbbs-source-save-919263` test stack
was visible and was left to its owning task. All four production services were
preserved and the application health check passed.

Operational records are under `deployments/repair-whole-quote-20261029/`:
`prepared.json`, `validation.json`, `built.json`, `deployment.json`,
`live-verification.json`, `post-deploy-audit.json`, `direct-data-correction.json`
and release/rollback manifests. Source snapshots and rollback records follow the
host's latest-five-copy retention policy.
