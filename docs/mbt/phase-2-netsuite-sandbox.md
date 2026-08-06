# Phase 2 — NetSuite Sandbox Configuration

This is the Phase 2 plan recovered from the approved MBT implementation plan.
It is the scope boundary for Phase 2 work.

## P2.1 — Manual Sandbox Runbook

Create `docs/mbt/netsuite-sandbox-runbook.md` with an exact signoff table for:

1. Sandbox account ID and URL.
2. Active MBT subsidiary, legal name, internal ID, and base currency.
3. Customer 33 exact identity, active state, currency, terms, tax/credit state, and MBT subsidiary relationship.
4. Customer Sales Order form.
5. SOT cross-charge Sales Order form.
6. Customer Deposit form.
7. Service/rental/extension/exchange/pickup/dump/surcharge/discount/cross-charge items.
8. Tax strategy and mappings.
9. Revenue and deposit liability accounts.
10. File Cabinet folder.
11. Integration role read permissions.
12. Future Sales Order, Customer Deposit, and File Cabinet write permissions, marked `configured_unproven`.
13. Required transaction custom fields.

Recommended custom-field logical purposes:

- Local contract UUID.
- Contract sequence.
- Predecessor NetSuite Sales Order.
- Billing version ID.
- Billing-line UUID.
- External idempotency key.
- Physical load and plan date.
- Truck and driver.
- Source references.
- Raw distance metres/display kilometres.
- Rate-band reference.
- Downtown surcharge.
- Allocation evidence.

Actual NetSuite internal/script IDs remain configuration values and are never hardcoded into domain logic.

Phase 2 must not provide an `--allow-production` mode.

## P2.2 — Read-Only NetSuite Adapter

Implement a narrow dependency-injected adapter exposing read methods only.

It may use existing OAuth, SuiteQL, and metadata-catalog infrastructure, but it must not expose the generic NetSuite write client to the preflight service.

Checks include:

- Direct access is enabled on the designated NetSuite source deployment.
- Environment matches an explicit sandbox account allowlist.
- Subsidiary is active and matches configuration.
- Customer 33 matches expected identity and subsidiary relationship.
- Forms exist and are active.
- Items exist, are active, and are available to the MBT subsidiary.
- Accounts and tax configuration are readable and correct.
- Custom fields exist with compatible types and record applicability.
- File Cabinet folder is readable.
- Required metadata permissions are present.

If NetSuite permissions prevent a required check from being proven, return `unable_to_verify` and fail readiness. Do not add a SuiteScript workaround.

## P2.3 — Configuration UI and APIs

Place every Phase 2 setting under `/mbt/config` in a “NetSuite Readiness” tab.

APIs:

```text
GET  /api/mbt/config/netsuite/mappings
PUT  /api/mbt/config/netsuite/mappings
POST /api/mbt/config/netsuite/preflight
GET  /api/mbt/config/netsuite/preflight/latest
GET  /api/mbt/config/netsuite/preflight/:runId
GET  /api/mbt/config/netsuite/preflight/:runId/export
POST /api/mbt/config/netsuite/preflight/:runId/signoff
```

Behavior:

- Mapping writes require revision, idempotency key, and audit reason.
- Only one preflight may run at once.
- Persist every check with stable code, expected value, observed value, severity, and message.
- Export JSON and CSV reports.
- Signoff requires Admin, a passing current configuration hash, and an audit note.
- Any mapping change invalidates the signoff immediately.
- Posting flags remain disabled even after signoff.

## P2.4 — Phase 2 Test Gate

Automated tests:

- Complete valid readiness fixture passes.
- Every required mapping missing individually fails.
- Inactive item/customer/subsidiary fails.
- Wrong subsidiary fails.
- Production account fails even with valid credentials.
- Missing permission and `unable_to_verify` fail.
- Mapping edit invalidates the old pass.
- Stale mapping revision returns 409.
- Preflight adapter records zero POST, PUT, PATCH, or DELETE calls.
- Hostile metadata text is safely escaped in UI and exports.
- Integer currency values and mapping hashes are stable.
- Role matrix protects every direct endpoint.
- Operational posting adapter remains unreachable.

Manual sandbox evidence:

- Run the read-only preflight against the approved sandbox.
- Export and attach the report.
- Record account ID, configuration hash, run ID, date, actor, and signoff note.
- Do not create a probe transaction.

Phase 2 completes only when:

```bash
./tools/mbt-gauntlet.sh P2
```

passes and the current sandbox preflight is signed off in `docs/mbt/evidence/P2.md`.
