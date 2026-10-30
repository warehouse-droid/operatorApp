# Repair office purchasing and Team parts evidence — 2026-10-28

Tier 3: purchasing, stock, authority, evidence, and retry safety.
Spec: `test/repair/spec.md`, criteria 51–55 and the Bill reconciliation refinement.
Spec approval: not obtained (autonomous run). No dependencies or commits added.

Deployed at 17:19:55 UTC to `https://test.mbbsoperation.com/repair/`.
Image: `mbbs-operator-app:repair-office-purchases-20261028`.
Image ID: `sha256:5df6cf466857d014262b97b5cf3b881018d6e11f3d9a819c02020c80989f1b4b`.
The 36-file delta was merged over `mbbs-operator-app:return-cards-20261028`;
unrelated live changes and the other three production services were preserved.

## Acceptance mapping

| Behavior / failure mode | Executable evidence |
| --- | --- |
| Office places multiple local POs without fabricating parts requests; approval and completion gates remain | `office-purchase-flow.test.js`: direct PO and four-step cases; `job-flow.test.js`: PO races, partial orders, successive orders |
| Team receives partial quantities without costs; stale commands/replays cannot move stock twice | Four-step and incoming-parts cases; existing stock correction property and HTTP concurrency cases |
| Invoice follows receipt; only one direct Bill is queued/posted; queued is distinct from posted | Four-step and imported-incomplete-PO worker cases; existing NetSuite adapter tests |
| Original PO prices survive invoice changes; Bill receives invoice prices | Four-step case asserts original and invoice prices in the real repository/worker flow; PDF regression |
| One atomic metadata Save; approval invalidation and audit history survive corrections | Atomic Save and combined equipment/metadata cases; equipment hierarchy regressions |
| Expanded Cancel, Link WOR/SOS, then Work history; existing Bill reconciliation retained | `office-purchase-browser.test.js`: metadata layout and full purchasing cases |
| Original images preview in Office, Team and the owner's requester page | Image preview browser case; existing original-byte/privacy API tests |
| Parts usage defaults to use on this job with no scope/movement selector | Pre-quote/default-usage API case and Office browser assertions; editable stock usage regression |
| Team searches parts and adds request-specific photos before quotation | Search/photo browser case and cross-job/kind evidence rejection case |
| Failed photo upload retains the request and retries only unsaved photos | Phone browser retry case; deliberate lost-retry and blocking-message mutants |
| Existing request ownership, delegated receipt boundaries, job aggregation, one parent receipt, fleet holds | Complete requester, handover, multi-job, equipment and property suites |

## Final fresh run

Entry point, from `server`:

```sh
sudo -n python3 tools/repair-office-purchases-release.py validate
```

The entry point uses the captured candidate and scoped patch, the repository's
bounded disposable runner, and its automatically cleaned artifact directory.
Candidate and per-file hashes are in the retained operational release records.
Repair source hash:
`f42cd8d4ba5d534173edb35ac7cc58d1f96ed5154644c91ec440f5ecd86e9c17`.
Integration hash:
`a1949b4d2f9d78460b0baa418bb51fe2b03b3e98bbbed880c965c8ac8af00612`.

- Repair tests: **128/128** normally, **128/128** with coverage, and **128/128** in reversed file order.
- Affected regressions: **40/40**, across nine isolated files.
- Shared login, menu and notification browser files: passed.
- Changed backend/shared-domain executable lines: **97/97 covered**. Browser assets and SQL are exercised through browser/API and fresh-database migration tests.
- Overall instrumented lines/statements: 93.23%; branches: 83.47%. No claim of complete branch coverage.
- Manual mutation checks: **30/30 caught** (5 domain/schema, 3 Team, 9 flow, 5 requester/receipt, 8 purchasing). Four selected mutants also failed against property tests alone.
- ESLint, TypeScript, server syntax and scoped secret scan: passed.
- Known unchanged baseline: `S11: the guarded client ships in a new atomic Driver shell generation`; its other three contract checks passed. No new failures.

Tools: Node 20.20.2, ESLint 10.8.0, TypeScript 7.0.2, c8 12.0.0,
fast-check 4.9.0, Playwright 1.62.1. Existing seeded property tests cover stock
conservation, rounding, hostile quote payloads and requester privacy.

## Corrections and operational limits

Behavioral RED checks reproduced the missing workflow, lost original PO prices,
and missing Bill-link control before their fixes. A phone retry exposed an error
message intercepting the retry button; the message now permits pointer events
through it. New test assumptions about bigint yard IDs, retained superseded
quotes and the `history` field were corrected to the existing API contract.
Type checking caught the optional purchase-line array and prompted normalization.
The final run above followed every source edit and the concurrent-release rebase.

Migration `320_repair_unscoped_parts.sql` was applied transactionally after a
Repair-table backup, whose archive listing and SHA-256 were verified. It permits
unscoped parts requests/usage and explicitly associates photos with a parts request;
existing records remain. A rollback application image is retained. No destructive
live database restore was performed.

Live verification passed all **36** source hashes and **18** local/public HTTP
checks. Application configuration and the other services were preserved.
NetSuite posting remains **disabled** in existing settings; Bills queue until it
is enabled. Tests use fake NetSuite boundaries, never live financial writes.
Physical-device camera/installation/notification prompts remain untested; desktop
Chromium exercised phone and tablet layouts and uploads.

Both `docker ps` and `docker ps -a` contained only the four production containers
after cleanup. Disposable containers, database volumes, test networks, media,
coverage, mutants and raw logs were removed by the outer runner. Only concise
source evidence and operational release/backup/rollback records are retained.

Operational records: `deployments/repair-office-purchases-20261028/`:
`prepared.json`, `validation.json`, `migration-audit.json`, `deployment.json`,
`live-verification.json`, and `post-deploy-audit.json`.
