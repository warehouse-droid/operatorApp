# MBT Bin Operations Phase 2 Executable Specification

Status: approved by the user's request to implement Phase 2 according to the
previously approved P2 plan. This specification is append-only during Phase 2.
The authoritative scope is `docs/mbt/phase-2-netsuite-sandbox.md`.

## Failure model

| Failure mode | Required detecting layer |
|---|---|
| A production NetSuite account is contacted | Pure environment guard, adapter transport test, and real HTTP preflight test |
| Preflight sends any mutating HTTP method | Transport recorder proving every outbound preflight request is `GET` |
| A generic NetSuite write client reaches readiness code | Import/capability contract and injected-adapter tests |
| A wrong subsidiary or customer 33 passes | Required-check fixtures and observed-vs-expected validation |
| A missing, inactive, incompatible, or unreadable mapping passes | One-negative-at-a-time generated tests and persisted-result assertions |
| A browser omits a required check | Server-owned immutable requirement-catalog tests |
| Two Admins overwrite one mapping revision | Independent-client row-lock race and stale-revision HTTP 409 tests |
| An exact mapping/signoff retry repeats its audit mutation | Durable command-receipt idempotency tests |
| Two preflights execute concurrently | Database singleton claim race and HTTP 409 tests |
| A process dies during preflight and blocks readiness forever | Stale-run expiry/recovery integration test |
| A mapping changes after a pass or signoff | Canonical-hash invalidation at repository, HTTP, and browser layers |
| A failed or stale run is signed off | Database-backed signoff command tests |
| Preflight evidence or signoff history is rewritten | PostgreSQL UPDATE/DELETE rejection tests |
| Credentials or full NetSuite payloads enter evidence | Projection/redaction, secret scan, and adversarial transport fixtures |
| Hostile metadata executes in the UI or spreadsheet | Browser text-only rendering, HTML escaping, and CSV formula-neutralization tests |
| A report is incomplete or changes order nondeterministically | JSON/CSV golden-contract and shuffled-input tests |
| Signoff activates posting or another MBT operation | Capability-state comparison before/after signoff and outbox-count tests |
| Existing Dispatch, Driver, SCM, auth, or P1 behavior regresses | Full P1 plus legacy harness gauntlet |
| The implementation appears green without a real sandbox signoff | Evidence report must state the external gate as pending; completion is forbidden |

## Approved setup and immutable boundaries

- Add migration 108 for Phase 2 preflight/signoff evidence. Do not edit an
  already applied Phase 1 migration.
- Add exact tests, fixtures, browser coverage, manual mutants, runbook, and P2
  evidence support to the existing isolated test stack.
- Add `MBT_NETSUITE_SANDBOX_ACCOUNT_ALLOWLIST`; absence fails live sandbox
  readiness. There is no production override or production adapter path.
- Reuse the existing OAuth token store only behind a narrow GET-only function.
  Preflight code must not import or receive create/update/delete functions.
- Keep `MBT_ENABLED`, every operational database flag, and
  `MBT_NETSUITE_WRITES_ENABLED` closed. No P2 command may create a contract,
  visit, reservation, movement, billing version, deposit, or outbox task.
- Actual NetSuite IDs are Admin-entered configuration. No undocumented ID or
  script ID is inferred or seeded.
- Phase 1's no-controls assertion for `/mbt/config` is superseded only for the
  Phase 2 NetSuite Readiness configuration controls. Front Desk, Billing,
  Dispatch, Driver, and posting remain controlled and non-operational.

## Server-owned required mapping catalog

The server owns stable logical keys for the approved P2 checklist:

- MBT subsidiary and intercompany customer 33.
- Customer Sales Order, SOT Sales Order, and Customer Deposit forms.
- Initial service, rental, extension, exchange, pickup, dump, downtown
  surcharge, discount, and cross-charge items.
- Default tax mapping, transport/dump/rental revenue accounts, and deposit
  liability account.
- Receipt File Cabinet folder.
- Read permissions needed to verify subsidiary, customer, forms, items,
  accounts/tax, custom fields, and folder metadata.
- Future Sales Order, Customer Deposit, and File Cabinet permissions, whose
  Phase 2 expectation is exactly `configured_unproven`; no write probe occurs.
- The custom-field logical purposes enumerated in the approved P2 plan.

The catalog defines expected record kind, verification kind, required status,
severity, expected subsidiary relationship/type/applicability where relevant,
and display guidance. A client cannot remove or downgrade a required check.

## Behavior scenarios

### P2-F01 — Sandbox-only GET adapter

Given direct access is disabled, the account is absent from the exact sandbox
allowlist, the identifier/URL is production-like, or the configured account
does not equal the runtime account, preflight fails before an outbound request.

Given valid sandbox configuration, every remote operation is an allowlisted
`GET` under the configured NetSuite REST base URL. Path segments are encoded,
redirects are rejected, timeout/403/404 and malformed results become bounded
check outcomes, and only whitelisted observed fields are persisted.

### P2-F02 — Revisioned mapping configuration

Admin lists the server-owned requirements joined to current mapping revisions
and retained history. A PUT supplies one logical key, its complete mapping,
expected revision, audit reason, and `Idempotency-Key`.

For an absent key, expected revision 0 creates revision 1. For an existing key,
the exact current revision creates the next revision and retires the former
revision atomically. A stale revision returns 409/code `MBT_STALE_REVISION` and
does not alter mappings, audit, receipts, preflight evidence, or outbox state.
Exact retries replay; changed payload under the same key conflicts.

### P2-F03 — Complete deterministic preflight

POST preflight derives all checks from the server catalog, never request data.
It stores a running record before reads and exactly one terminal result per
requirement with stable code, expected projection, observed projection,
severity, and safe message. A complete valid fixture passes. Each required
mapping independently missing, inactive, wrong-subsidiary, incompatible,
permission-denied, or unable-to-verify fails readiness.

Only one non-stale run may be active. A competing request receives 409/code
`MBT_NETSUITE_PREFLIGHT_RUNNING`. An abandoned run older than the configured
lease is closed as `unable_to_verify` before a replacement starts.

### P2-F04 — Current readiness and signoff

Latest/detail reads are Admin-only and no-store. Readiness is true only for a
terminal passing run whose configuration hash equals the current canonical
mapping hash. Signoff additionally requires that exact current pass and a
nonblank audit note. It is immutable, audited, idempotent, and unique per run.

Changing any mapping creates a new configuration hash. Historical pass and
signoff evidence remain visible but immediately cease to be current. Signoff
does not alter environment flags, database feature flags, outbox rows, or any
operational table.

### P2-F05 — Deterministic safe reports

The export endpoint returns a deterministic JSON report or UTF-8 CSV for one
persisted run, including account, environment, configuration hash, run status,
ordered checks, and current/historical signoff state. It excludes OAuth tokens,
client secrets, raw payloads, and unrestricted response fields. CSV quoting is
RFC 4180-compatible and cells beginning with spreadsheet formula characters
are neutralized. Filenames contain only the run UUID.

### P2-F06 — Admin readiness UI

`/mbt/config` contains an accessible “NetSuite Readiness” tab showing closed
operational gates, the requirement/mapping table, validation results, latest
run, current signoff state, JSON/CSV export, and Admin mapping/preflight/signoff
controls. All remote text is rendered with text nodes or form values, never
HTML insertion. Network and validation failures remain visible and actionable.

No non-Admin role can read or mutate any Phase 2 endpoint, including by direct
HTTP calls or client-asserted role headers.

### P2-F07 — Honest completion boundary

The automated P2 gauntlet covers fresh and schema-107 upgrades, unit/property,
database/concurrency, real HTTP, browser/accessibility, coverage, mutation,
types/lint, shuffled runs, dependency/license/secret checks, production-image
startup with gates closed, and the full legacy baseline.

Automated GREEN is not a Phase 2 completion claim. `docs/mbt/evidence/P2.md`
must separately record the approved sandbox account ID, configuration hash,
run UUID, timestamp, actor, signoff note, attached export, and proof that no
probe transaction was created. If sandbox access is unavailable, the evidence
must mark that gate pending and Phase 2 remains incomplete without guessing.

## Quality constraints

- New P2 server code reaches at least 95% lines/functions and 90% branches.
- Each pure property runs at least 1,000 generated cases.
- Independent-client concurrency races are repeated at least 25 times.
- Every persisted P2 mutant is killed and source hashes restore exactly.
- All P1 tests and the complete explicit legacy harness allowlist remain green.
- A final claim is based only on one fresh `./tools/mbt-gauntlet.sh P2` run.

## P2-R1 — Immutable-fixture repeatability clarification (2026-08-03)

The initial repository RED exposed a test-fixture ordering defect before GREEN:
multiple test processes intentionally append retained revisions to the same
server-owned mapping catalog, while the shuffled repetitions reuse their
isolated database. A fresh database must still prove expected revision 0
creates revision 1. A repeated/shuffled test process must instead derive the
current revision and prove the same append/replay/stale invariants relative to
that retained baseline. Tests must not delete evidence, disable immutability
triggers, invent a non-catalog key, or weaken the production create contract.

The same rollback fixture gives both mapping audit rows one PostgreSQL
transaction timestamp because `now()` is transaction-stable. The repository
test therefore orders retained audit evidence by semantic revision, then
action and UUID as a final tie-breaker; it does not infer command order from a
random UUID when timestamps tie. No audit assertion or production behavior is
weakened.

## P2-R2 — Production GET-transport proof (2026-08-03)

The initial injected-adapter RED correctly proved that preflight orchestration
cannot request a write. A post-RED boundary review found that this does not by
itself execute the production OAuth-backed transport. Additive tests must
therefore exercise that exact bridge with an isolated database token and a
recording fetch implementation. They must prove that only an already-unexpired
stored access token is used, the target remains below the configured sandbox
Record REST root, the HTTP method is exactly GET, redirects and path/query
escapes are rejected, response size and parsing are bounded, and an absent or
expiring token returns `unable_to_verify` without invoking the legacy refresh
flow. This adds no generic request function and does not authorize a live
network call.

## P2-R3 — Official REST verification strategies (2026-08-03)

The first GREEN fake transport exposed a production-readiness defect during
review: several catalog `expectedRecordType` values were semantic placeholders
(`sales_order_item`, `sales_order_form`, `transaction_custom_field`, and
`integration_permission`), not demonstrated REST Record endpoint names. A
fake fixture must never make an unsupported live endpoint appear verifiable.

The server catalog must therefore distinguish the logical mapping kind from a
server-owned read strategy and an allowlist of real Record REST types. Direct
record checks may call only allowlisted `{recordType}/{encodedInternalId}` GET
paths. Transaction custom fields use only the documented
`metadata-catalog/{parentRecordType}` GET and extract one configured script ID
from the bounded JSON-schema projection. Read-permission checks may be derived
only from the corresponding successful/denied representative GET evidence;
future write permissions remain exactly `configured_unproven` and perform no
write probe. A form, folder, role-permission, or other setup object for which
no official GET proof is configured must return `unable_to_verify`; an Admin
mapping or fake payload cannot turn it into a pass. SuiteQL POST, SuiteScript,
RESTlets, SOAP, and transaction probes remain forbidden.

The transport and adapter still expose only one frozen read capability. Tests
must use official endpoint-shaped fixtures, assert every requested path and
Accept header, prove unsupported strategies issue zero requests, and retain
all earlier production/allowlist/secret-projection guards.

## P2-R4 — Editable semantic verification configuration (2026-08-03)

The initial UI preserved a mapping's JSON `configuration` but offered no way
to enter the approved subsidiary, currency, account, field-type, or
applicability expectations required by the runbook. The mapping editor must
round-trip a validated JSON object containing the expected bounded evidence
and explicitly declared case-insensitive fields. Invalid JSON or a non-object
must remain in the editor with an actionable error and send no request. The
server-owned catalog expectations continue to override, never be removed by,
Admin configuration. The UI renders the value as form text only; it must not
accept credentials or make an operational flag writable.

## P2-R5 — Bounded readiness execution and metadata reuse (2026-08-03)

A post-GREEN security review found that sequential worst-case remote reads
could exceed the finite preflight lease, and that multiple custom-field checks
could refetch the same parent metadata schema. Readiness must evaluate
independent, non-derived evidence with a fixed concurrency ceiling of four.
It must never exceed that remote-read ceiling, and both the returned checks and
the persisted completion payload must retain exact server-catalog order even
when responses complete out of order. Derived permissions run only after all
their representative evidence is available. Unsupported and future
configured-unproven checks continue to issue zero requests.

Within one read-only adapter lifetime, concurrent or sequential
`metadata_catalog` reads for the same parent record type must share one raw
schema-payload promise. Each configured script ID is still projected and
validated independently; a cached projection for one field must never stand in
for another field. Different parent record types do not share payloads. A
failed request is evicted so a later attempt may retry, and this bounded
in-memory reuse is not durable readiness evidence or a cross-account cache.

Executable latency evidence must include a slow-but-within-timeout fixture
whose parallel completion remains safely inside the configured lease budget,
an exact maximum-active-request assertion, deliberately out-of-order response
completion, deterministic catalog/result ordering, per-parent schema-request
counts, and zero-request unsupported/future assertions. This revision changes
no write boundary and does not substitute for the required live sandbox
preflight and signoff.

## P2-R6 — Runtime-current and official semantic evidence (2026-08-03)

A complete automated gauntlet exposed no failing gate, but the required
independent review found that the tests had not proved three safety
properties. The green run is retained as pre-revision evidence only and
cannot support Phase 2 acceptance.

First, NetSuite runtime settings must be resolved once per HTTP request, not
captured when the Express router is constructed. The immutable runtime
fingerprint is versioned and binds the exact account, normalized Record REST
root, sandbox environment, direct-access state, canonical exact sandbox
allowlist membership, read timeout, and effective preflight lease. An
order-only allowlist change is equivalent; any membership or bound-setting
change makes an earlier pass and signoff non-current. A live environment-file
switch cannot leave the old sandbox visible or signable as current.

Second, a mapping cannot omit semantics that the approved runbook requires.
The server-owned catalog declares required configurable evidence fields.
Subsidiary requires legal name and base currency; customer 33 requires exact
identity, currency, terms, tax, and credit-state evidence; transaction custom
fields require a compatible field type and server-derived parent
applicability. Related customer and item mappings require a dedicated
subsidiary internal ID equal to the current `subsidiary:mbt` mapping.
Preflight checks actual membership in the observed subsidiary collection, so
membership in `[MBT, another subsidiary]` passes while absence of MBT fails.
A mapping whose target differs from the MBT mapping fails before a remote
request. Every direct record read must return the exact requested record ID;
absence is not success.

Third, supported proof uses Oracle REST field and record identifiers rather
than test aliases. Subsidiary evidence reads legal name and the `currency`
reference; account evidence reads `acctType`, account name, and subsidiary
membership. Service Sale Item uses `servicesaleitem` and Non-Inventory Sale
Item uses `noninventorySaleItem`; the old spellings are rejected. Revenue and
deposit account mappings require an exact configured Oracle account-type ID
constrained by the server-owned income or liability category. Compatibility
aliases may be projected defensively, but no passing fixture may rely on them
as proof.

The Admin readiness UI must also display the current non-secret runtime
binding (account, normalized REST root, direct-access state, allowlist,
timeout, and effective lease), identify required semantic fields in the
editor, and make the dedicated subsidiary field required only where the
catalog requires it. These values remain read-only and expose no OAuth token
or credential.

Frozen RED evidence must prove all of the following before implementation:

- each bound runtime change invalidates currentness and signoff, while
  allowlist order alone does not;
- a mutable runtime provider changes latest/detail/signoff behavior without
  rebuilding the router;
- incomplete subsidiary, customer, custom-field, and account semantics are
  rejected with stable bounded errors;
- wrong configured or observed subsidiary relationships fail,
  multi-subsidiary MBT membership passes, and mapping mismatch performs zero
  reads;
- a direct response missing its ID cannot pass;
- official subsidiary/account payloads and official item record paths pass,
  while the former spellings and wrong account type fail; and
- the browser renders the non-secret runtime binding and semantic
  requirements without enabling an operational control.
