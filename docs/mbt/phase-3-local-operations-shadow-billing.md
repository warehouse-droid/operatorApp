# Phase 3 — Local Operations, Pilot, and Shadow Billing

Status: **APPROVED FOR LOCAL IMPLEMENTATION**, 2026-08-03. The user's explicit
`$old-coder please implement phase 3` request authorizes packets P3.0 through
P3.11 in an isolated local/test environment. Production deployment, restart,
feature activation, live NetSuite access, and importing the real customer
workbook remain separately unauthorized.

This is the restart document for Phase 3. It deliberately combines the source
design's original Phase 3 (master data), Phase 4 (operational pilot), and Phase
5 (billing shadow) into one local-first delivery. It does not authorize the
source design's Phase 6 NetSuite writes.

## 1. Outcome and phase boundary

Phase 3 must make one controlled BIN order work from end to end:

```text
Customer source (NetSuite read or CSV bootstrap)
  -> local master data
  -> Front Desk quote and contract
  -> current Dispatch plan as an isolated BIN visit
  -> Driver PWA execution and evidence
  -> asset/distance/receipt reconciliation
  -> local-only MBT billing and MBBS cross-charge shadow cases
```

The normal customer source is a read-only NetSuite synchronization. For the
current local setup and when the NetSuite source is unavailable, an Admin may
upload a CSV exported from or prepared against NetSuite. Both inputs go through
one canonical validation and apply service. CSV is not a second customer
master and cannot create a customer without a real positive NetSuite internal
ID.

### Included

- Deploy a read-only, resumable customer synchronization and prove that it is
  compatible with the existing Returns directory and NetSuite mirror roles.
- Add customer CSV preview/import as the current bootstrap and recovery path.
- Add CSV and manual UI setup for local items, dump sites/material acceptance,
  bin assets, and rate cards.
- Reuse the existing Dispatch own yards `12441`, `3445`, `2967`, and `150` as
  MBT yards; do not create a second yard setup surface.
- Reuse the existing Dispatch truck registry and extend it with an explicit
  truck type (`flatbed` or `bin`) plus the existing BIN size/capacity fields.
- Add the minimum local material, condition, service-template, and site-profile
  setup required by the requested end-to-end workflow.
- Enable Front Desk locally for a controlled pilot.
- Enable asset registration, search, movement, correction, and reconciliation.
- Enable BIN visits in the current Dispatch planner without accounting posts.
- Pilot BIN Driver PWA workflows online and offline.
- Compare application movements, receipts, distances, and charges with manual
  records without overwriting either source of evidence.
- Generate and approve local-only MBT contract billing and MBBS cross-charge
  cases without posting.
- Resolve calculation and evidence variances through audited, append-only
  corrections or accepted explanations.

### Excluded

- NetSuite Sales Order, Customer Deposit, file, item, customer, or transaction
  writes of any kind.
- Enabling `MBT_NETSUITE_WRITES_ENABLED` or the database
  `mbt_netsuite_writes` flag.
- Treating Phase 2 readiness/signoff as permission to post.
- Provisional customer identities, customer matching by name/email/phone, or
  manually invented NetSuite IDs.
- Broad production activation. The first release is an allowlisted pilot with
  independent kill switches.
- Replacing the current Dispatch planner or the existing Driver offline-sync
  architecture.
- Using phone or Samsara GPS as financial distance evidence, or replaying stale
  Samsara writes.
- Deleting historical assets, movements, customers, visits, evidence, rate
  versions, billing versions, or reconciliation decisions.

## 2. Source specifications and explicit supersessions

The implementation must read these in order:

1. `/home/ubuntu/MBT Bin Operations Design Review.docx`.
2. `docs/mbt/00-implementation-index.md`.
3. `docs/mbt/01-executable-spec.md` and
   `docs/mbt/phase-1-foundation.md`.
4. `docs/mbt/02-executable-spec.md` and
   `docs/mbt/phase-2-netsuite-sandbox.md`.
5. `docs/mbt/03-local-first-configuration-spec.md`.
6. This document.

This document supersedes the earlier local-item scenarios LC01, LC04, and
LC08 only where they say the catalog contains exactly five identities and
unknown codes can never be created. The five seeded system concepts remain
protected and are never renamed or deleted, but an Admin may add audited
custom local items by CSV or manual UI. Pricing ownership remains normalized
as specified by LC-R1; the item catalog still does not own prices or UOM.

This 2026-08-03 Dispatch decision also supersedes any source-design reading
that would project every executable visit of a contract into the order pool at
the same time. Phase 3 projects at most the server-derived current ready front
visit for each contract; later visits remain contract context until advanced.

All earlier closed-gate, exact-money, immutability, audit, idempotency, and
zero-NetSuite-write guarantees remain in force.

## 3. Current foundation and material gaps

| Area | Reusable foundation | Phase 3 gap |
|---|---|---|
| Customers | Migration 103 has canonical customers, subsidiaries, addresses, contacts, sync runs/pages/state/conflicts, and local site profiles. | No sync/apply service, source adapter, CSV path, routes, UI, or compatibility publisher. |
| Returns customers | Migration 073 and `return-customer-directory.js` maintain a smaller customer cache used by established Returns flows. | It is currently a second writer and destructively reconciles a full snapshot. It must become a compatibility projection without changing its public response. |
| NetSuite mirror | Durable `netsuite-mirror/v1` covers SO, PO, TO, and inventory. Consumer deployments correctly disable direct NetSuite access. | Customers are not supported. Changing v1 in place would risk existing cursors and consumers. |
| Local items | Five protected concepts and an Admin edit screen exist. | No custom item creation or CSV import. The current DB/service rejects every additional code. |
| Yards/materials/dump sites | Dispatch already owns yards `3445`/location 1, `12441`/15, `2967`/28, and `150`/26; migration 104 has normalized MBT yard/material/dump tables. | The four existing yards need one relational shared backing in `mbt_yards`; materials/dump sites still need setup. A separate MBT yard import/UI would create conflicting masters. |
| Trucks | `dispatch_trucks` is the established fleet registry and Dispatch Settings already supports add/edit/disable. Migration 104 already adds `bin_service_enabled`, `bin_slot_capacity`, and `dispatch_truck_bin_types`. | The shared registry needs an explicit `flatbed`/`bin` type, safe defaults, UI fields, validation, audit/revision handling, and planner filtering. No second MBT truck table is needed. |
| Assets | Migration 104 and `asset-service.js` provide an append-only movement ledger, exact current state, reversals, and reservations. | No production registration/list/update/import UI or API. Registration must create movement sequence 1 and materialized state atomically. |
| Service templates | Versioned templates, ordered steps, and evidence requirements exist. | Nothing is seeded/configurable, so a Front Desk visit cannot be made ready. |
| Rates/contracts/visits | Migration 105 contains draft/active rate versions, bands, components, tariffs, deposits, quotes, contracts, visits, steps, evidence, distances, and reservations. | No setup service, calculator, operational API, or UI. |
| Dispatch | BIN schema and fail-closed safety guards exist; contracts already own ordered service visits. | The order feed/UI does not model BIN as a first-class contract leg. It must show only the contract's current front leg, retain later legs as read-only context, and never assign the whole contract or expose future legs prematurely. |
| Driver PWA | Local-first manifests, photos, events, offline sync, conflict review, and occurrence timestamps already exist. | BIN data is omitted from job projections/manifests and completion currently has no BIN operational branch. |
| Billing | Migration 106 and local-only approval foundations exist. | No calculators/generators or draft-line builder; current approval cannot generate the requested cases by itself. |
| Test gauntlet | P1/P2/local-first Tier 3 infrastructure exists. | `mbt-gauntlet.sh P3` currently falls through to P1 behavior and is not valid Phase 3 evidence. |

## 4. Immutable Phase 3 decisions

### 4.1 Customer identity and source precedence

- `netsuite_customers.netsuite_id` is the only customer identity. It is a
  positive NetSuite internal ID regardless of whether the record arrives from
  NetSuite or CSV.
- NetSuite is authoritative for customer name, state, currency, terms,
  tax/credit status, subsidiaries, addresses, contacts, and source version.
- Local site access instructions, gate codes, placement notes, service windows,
  local contacts, and operational coordinates remain in
  `mbt_customer_site_profiles`; synchronization never overwrites them.
- CSV means `csv_bootstrap`, not `local_customer`. It represents a NetSuite
  snapshot and must identify its source account and export/as-of time.
- A canonical NetSuite observation takes precedence over CSV. Once an entity
  has been observed from live NetSuite, a later CSV cannot overwrite its
  source-owned fields. It becomes a reviewable conflict unless the incoming
  normalized payload is identical.
- Before live observation, CSV may update a CSV-bootstrapped row only when its
  source timestamp/version is newer. Equal-version/different-payload input is
  a conflict; older input is ignored and reported.
- Missing CSV rows never imply deletion or inactivation. A full successful
  NetSuite reconciliation may mark absent source records inactive, but never
  deletes them.
- Inactive customers remain available to historical contracts and billing but
  cannot start a new quote/contract.

#### Observed bootstrap workbook

The current source file is `/home/ubuntu/MBT_customer_20260803.xls` (1,029,973
bytes; SHA-256
`b4fd35e134626543d3e94cbbb0ef898f99dd168b9452eef64986dd8a4f3b95dc`).
It is a NetSuite-authored Excel 2003 XML/SpreadsheetML document, not a binary
OLE `.xls` workbook. It remains outside Git because it contains customer PII.
Tests use a small synthetic structurally equivalent fixture, never copied live
rows.

Read-only inspection found one `CustomersProjects` worksheet, 1,262 data rows,
zero blank/duplicate internal IDs, and these columns:

```text
Internal ID, Name, Primary Contact, Category, Primary Subsidiary,
Sales Rep, Partner, Status, Phone, Email
```

The frozen aggregate preview expectation is 1,252 rows for the exact
`Mr.Bin Holdings Group Inc. : Mr Bin Trucking Inc.` hierarchy, of which 1,251
also have `CUSTOMER-Closed Won` status; 10 rows name another primary subsidiary
and one target-subsidiary row has `PROJECT-` status. There are 47 names without
the leading six-digit pattern, 187 blank emails, and 11 blank phones across all
rows. After the subsidiary/status eligibility filter, the import preview reports
39 incomplete entity numbers, 182 blank emails, and 2 blank phones. These are
review counts, not reasons to invent missing data.

The workbook contains no address, currency, terms, tax/credit, source-modified,
or stable contact-ID fields. Therefore:

- it can bootstrap the customer core, but it cannot by itself make a customer
  service-ready;
- an active NetSuite address synchronization or a companion address CSV with
  stable NetSuite address IDs is required before creating a local site profile
  and Front Desk visit;
- the Admin must select the source account, exact subsidiary label, CAD/default
  currency, and export-as-of time at preview; these values are visible in the
  review and become immutable import evidence;
- `source_version` is derived from the workbook hash and provenance remains
  `csv_bootstrap`, so an eventual live NetSuite record always supersedes it;
- a leading exact six-digit token in `Name` may populate the bootstrap entity
  number; rows without it use an explicit `NSID-<internal-id>` incomplete
  marker and remain flagged for NetSuite hydration rather than being matched by
  name;
- `Name` is retained unmodified as the bootstrap display/legal text. NetSuite
  later replaces source-owned names; no heuristic company-name rewrite occurs;
- Phone and Email populate the customer core. `Primary Contact` is not promoted
  to a canonical contact because the workbook supplies no stable contact ID;
- Category, Sales Rep, and Partner are preview-only ignored columns unless a
  later approved schema revision gives them an operational owner; and
- only rows whose Primary Subsidiary exactly equals the Admin-approved MBT
  Trucking hierarchy are eligible by default. Rows for another subsidiary and
  the non-customer `PROJECT-` status are reported and skipped, not silently
  activated.

This particular export contains one unescaped ampersand inside a text value,
so it is not strictly well-formed XML. The importer may recover a bare
ampersand only inside a bounded `<Data>` text node and must report that repair
in preview. It must reject malformed structure, attributes, declarations,
entities, formulas, links, macros, or additional executable workbook content.

### 4.2 Existing mirror and Returns compatibility

- Preserve `netsuite-mirror/v1` byte-for-byte and behavior-for-behavior for SO,
  PO, TO, and inventory. Do not add customer event types to its v1 constraint,
  cursor, manifest, or reconciliation methods.
- Introduce a separate signed durable contract named `customer-master/v1`
  with an event cursor plus bounded full-snapshot reconciliation. It may share
  transport/authentication helpers, but has independent tables, retention,
  cursor, metrics, failure queue, and schema fixtures.
- A mirror-source deployment performs read-only NetSuite customer pulls,
  applies the canonical model, then publishes committed customer changes.
  A mirror-consumer deployment never calls NetSuite; it applies the signed
  `customer-master/v1` events/snapshots. CSV bootstrap is permitted on either
  role through the same canonical apply boundary.
- Project committed canonical customers into the legacy
  `return_customer_directory` shape during a measured dual-read period.
  Preserve `/api/returns/customers`, its result ordering/fields, pallet-return
  behavior, and fallback semantics.
- Only one writer may own the Returns projection after cutover. Disable its
  old direct refresh scheduler only after canonical freshness and parity gates
  pass. Keep an independently controlled rollback read path until the pilot is
  accepted.
- Durable database state, not SSE/in-memory notifications, is the recovery
  source after a process or server restart.

### 4.3 Local catalog and pricing ownership

- Preserve the five protected codes: `DELIVERY_CROSS_CHARGE`, `14YD`, `20YD`,
  `40YD`, and `DUMP`.
- Add custom local catalog rows in the same user-facing catalog with a distinct
  `system_owned` marker. Codes are normalized uppercase and immutable after
  creation. Protected identities can never be changed; no row is hard-deleted.
- Allowed custom categories are `bin_charge`, `dump`, `service`, `surcharge`,
  `discount`, `cross_charge`, and `other`. Allowed pricing modes remain
  `calculated`, `rate_card`, and `custom_price`.
- Local items own identity, display, description, category, applicable service
  or legacy source types, optional bin type, pricing mode, active state, and
  revision. They do not own price, UOM, currency, tax, or a required NetSuite
  mapping.
- Any future NetSuite mapping is nullable metadata and has no operational effect
  in Phase 3.
- Manual entry and CSV import call the same command validator/repository and
  produce the same audit and idempotency evidence.

### 4.4 Operational and accounting isolation

- A BIN Dispatch entry represents an `mbt_service_visit`, not a disguised SO.
  Its schema-backed display/reference identity is
  `BIN-<contract-number>-V<visit-number>` plus the visit UUID and immutable
  snapshot revision.
- `canonicalDispatchOrderType` must recognize `BIN`; unknown types must fail
  closed rather than fall back to SO. Preserve the existing recognized legacy
  aliases/ID inference, but handle explicit BIN before any legacy fallback.
- BIN work cannot call ordinary fulfillment, receiving, dependency, custom
  order, SCM, PO/TO/SO/VRMA completion, or notification side effects.
- A Driver BIN completion goes through a dedicated orchestrator before generic
  pickup/drop-off effects. It atomically applies visit/step/evidence/asset
  changes and the existing driver job record under one idempotency identity.
- All financial results use integer minor units and immutable server-owned
  distance snapshots. Driver/Samsara/phone location may support operations but
  is never billing distance.
- Every billing case in Phase 3 is `posting_mode = local_only`. Approval creates
  zero NetSuite chain, outbox, posting-attempt, or transport work.

### 4.5 Shared yards and trucks

- The established Dispatch **Own Yards** concept, API, and Settings UI remain
  the operational yard master interface. Current saved Dispatch values are the
  one-time bootstrap source; relational `mbt_yards` rows become the backing
  store after cutover. The exact Phase 3 mappings are:

  | Yard code | Existing NetSuite/Dispatch location ID |
  |---|---:|
  | `12441` | 15 |
  | `3445` | 1 |
  | `2967` | 28 |
  | `150` | 26 |

- These same four records back MBT asset home/current yards, visit stops,
  distance endpoints, and reconciliation. Do not ask an Admin to recreate or
  CSV-import them in an MBT-specific screen.
- `mbt_yards` is the relational shared backing required by existing MBT foreign
  keys. Each row has one immutable UUID plus a unique positive Dispatch
  location ID and stable yard code. The existing `/api/dispatch/setup`
  `ownYards` response shape and Own Yard Addresses UI remain compatible.
- The numeric location IDs `15`, `1`, `28`, and `26` are external Dispatch/
  NetSuite identities, not MBT yard UUIDs. Code must never coerce one identity
  into the other. Yard `150` legitimately has no coordinates today; bootstrap
  preserves that null pair rather than inventing a geocode.
- After cutover, the relational shared rows are authoritative and the existing
  Dispatch setup JSON is only a backward-compatible projection/fallback. A
  Dispatch Settings command commits the database first, then refreshes the
  derived file using atomic file replacement. Because database and filesystem
  cannot share one transaction, a file-write failure is surfaced/audited and
  retried without rolling back or superseding committed database truth. Two
  independent yard writers are forbidden.
- A new own yard created through Dispatch Settings becomes an MBT yard through
  the same transaction/projection. Changing code/location identity or disabling
  a yard referenced by assets, visits, plans, or evidence is rejected; address,
  coordinates, name, and timezone are revisioned/audited.
- `dispatch_trucks` remains the only fleet table. Add `truck_type` with exact
  stored values `flatbed` and `bin`; UI labels are **Flatbed** and **Bin**.
- Every existing truck migrates to `flatbed`. A newly registered truck defaults
  to `flatbed` until the Dispatcher explicitly selects Bin.
- `truck_type` is the user-facing authority. The existing
  `bin_service_enabled` field remains as a compatibility projection and must
  equal `(truck_type = 'bin')`; it is not a second toggle.
- A flatbed truck has BIN slot capacity 0 and no active supported BIN sizes. A
  Bin truck requires slot capacity at least 1, at least one active supported
  bin type from `dispatch_truck_bin_types`, a base yard from the shared yard
  master, weight capacity, and travel-time adjustment.
- Add relational `base_yard_id` for Bin trucks as a foreign key to the shared
  MBT yard UUID. Preserve existing `baseYard` yard-code text in API and legacy
  plan snapshots as a resolved compatibility field, not the referential key.
- Flatbed loads retain the existing pallet/weight capacity behavior unchanged.
  BIN planning consumes discrete BIN slots plus payload/weight safety; it does
  not convert a bin into pallets or reuse Smart SCM truck-capacity overrides.
- Dispatch Settings is the only truck registration/configuration UI. Its Trucks
  tab adds Type, BIN slot capacity, and Supported bin sizes. Selecting Flatbed
  hides/clears BIN-only controls; selecting Bin makes them required.
- Truck type/capability changes are optimistic, audited, and rejected while the
  truck has an active/future incompatible plan, reservation, in-progress visit,
  Driver assignment, or unresolved offline evidence. Historical plan/visit
  snapshots retain the type and capabilities used at confirmation time.
- An existing-client truck update that omits Phase 3 fields preserves the
  stored type, base-yard FK, slot capacity, and supported sizes. Only creation
  of a genuinely new truck may apply the Flatbed default. Cleaning, public
  projection, insert, update, and fleet replacement must all round-trip the
  fields; `supportedBinTypeCodes` resolves transactionally to
  `dispatch_truck_bin_types` rather than being stored as unchecked JSON.

### 4.6 Contract front-leg projection

- The contract is the commercial order; an `mbt_service_visit` is its
  dispatchable leg. Dispatch assigns a leg, never the whole contract.
- “Contract leg” in this document means one complete service visit, which may
  contain several ordered physical stops. It is not an individual road segment
  or the template field `billable_leg_to_next`.
- Phase 3 contracts are a linear operational chain. Each leg has a stable visit
  number/reference and explicit predecessor. A contract may have only one
  current nonterminal front leg; branching requires a later spec revision.
- The **front leg** is the first nonterminal visit whose predecessor chain is
  terminal (`completed`, or explicitly `cancelled` with audit evidence). It is
  derived under database locking rather than stored as a client-owned boolean.
- Only a front leg in `ready` state whose service window belongs to the selected
  planning date appears in the unassigned BIN pool. A front leg already
  `planned`, `in_progress`, or `evidence_pending` appears only in its assigned
  plan and contract timeline. A `tentative` front leg and every later leg stay
  out of the unassigned pool.
- A later leg cannot become ready or appear because its date is earlier or a
  client sent a flag. Completion/cancellation of the predecessor, durable
  evidence, and readiness validation promote the next leg exactly once.
- An amendment that inserts an exchange/early pickup cancels or supersedes the
  old tentative successor with an audit trail, then links the new linear legs.
  It never renumbers or rewrites historical visits.
- The order-pool card is headed **BIN Contract <contract number> · Leg <visit
  number>** and shows action, customer/site, scheduled window, bin type, asset
  requirement, origin/destination/waypoints, and readiness warnings. A compact
  read-only timeline shows completed/current/future contract legs; only the
  current card is draggable.
- One leg may contain multiple mandatory physical stops. Examples are
  `12441 -> customer` for delivery and `customer -> dump site -> 12441` for a
  loaded pickup. Dragging the card assigns that entire leg to one load/truck;
  the planner materializes its ordered stops and may group the same physical
  visit with other work only while internal precedence and asset continuity
  remain valid. Mandatory stops cannot be split across trucks/loads, deleted,
  or reordered into an impossible asset path.

## 5. Roles, gates, and pilot containment

Keep the existing environment and database gates and add granular database
capabilities so master-data rollout does not accidentally enable operations:

| Gate | Writes allowed when enabled | Minimum role |
|---|---|---|
| `mbt_customer_sync` | Customer sync/import/conflict evidence only | Admin |
| `mbt_master_data` | Local items, shared-yard backing/cutover, materials, dumps, templates, rates | Admin |
| `mbt_asset_management` | Register/update/reserve/correct assets | Admin; Dispatcher for operational movement/reconciliation |
| `mbt_frontdesk_operations` | Quotes, site profiles, contracts, visits | `mbt_frontdesk` or Admin |
| `mbt_bin_dispatch` | Plan ready BIN visits and reserve exact assets | Dispatcher or Admin |
| `mbt_driver_execution` | Execute an already planned BIN visit | Assigned Driver |
| `mbt_billing_operations` | Generate/review/approve local shadow cases only | `mbt_billing` or Admin |
| `mbt_netsuite_writes` | **Must remain false** | none in Phase 3 |

Every operational gate also requires `mbt_enabled`, its environment equivalent,
the exact database flag, and pilot-scope authorization. Pilot scope is a
server-owned allowlist of customer IDs, contract IDs, driver IDs, truck IDs,
and plan dates. Absence means no live pilot work. UI visibility is not a
security or capability boundary.

Disabling a gate prevents new commands but does not hide retained evidence or
strand already recorded offline events. A read-only recovery/review path stays
available to authorized users.

## 6. Migration and data design

Use forward-only migrations after 109. Exact migration numbers are assigned at
implementation start after checking the branch; do not edit an applied file.

### 6.1 Import and customer-source evidence

Add durable, bounded tables for:

- import batches: resource kind, source kind, source account, file hash,
  normalized hash, schema version, status, actor, reason, idempotency identity,
  counts, timestamps, expiry, and safe metadata;
- staged normalized rows and row errors, excluding the raw uploaded file;
- import apply results and affected entity/revision identities;
- customer entity provenance (`netsuite_read`, `customer_master_event`, or
  `csv_bootstrap`) and last live-NetSuite observation;
- `customer-master/v1` source events, consumer inbox, high-water cursor,
  snapshot manifests, delivery attempts, and retention state;
- canonical-to-Returns projection generation, parity counts/hashes, cutover
  state, and last successful projection time.

Extend the customer sync kind/source constraints without rewriting history.
Existing incremental/full runs remain valid. CSV batches link to a canonical
sync/apply run but do not impersonate a live NetSuite run.

Do not retain the raw uploaded file after normalization. Retain its SHA-256, headers,
row numbers, bounded normalized values, safe errors, actor, and decision. Purge
successfully applied staging rows after 30 days. Retain apply/audit/conflict
evidence according to the existing audit policy. Never purge an unresolved
conflict.

### 6.2 Extensible master data

Evolve local items to allow protected system rows plus custom rows. Add import
provenance and revision history rather than weakening the protected identity
constraints.

Reuse existing normalized yard, material, dump-site, asset, template, and rate
tables. Add only missing history/import/correction/readiness fields or tables.
Do not create duplicate master tables merely to make CSV convenient. In
particular, yard and truck registration remain Dispatch-owned shared masters.

Asset registration is one transaction containing:

1. the asset row;
2. movement sequence 1 (`asset_registered`);
3. exact `mbt_bin_asset_state` materialization;
4. audit event and command receipt.

No API or import may insert an asset without this initial ledger entry.

Add a unique positive `dispatch_location_id` to the shared `mbt_yards` rows and
bootstrap the four exact code/ID pairs in section 4.5 from the currently saved
Dispatch own-yard values. Preserve their current address/coordinates rather
than seeding a competing copy. `/api/dispatch/setup` reads/writes the same
relational rows while retaining its established `ownYards` JSON contract; any
file projection is updated by that same command for rollback compatibility.

Extend `dispatch_trucks` rather than creating an MBT fleet table:

- add `truck_type text NOT NULL DEFAULT 'flatbed'` with
  `CHECK (truck_type IN ('flatbed', 'bin'))`, then explicitly backfill every
  current row to `flatbed`;
- add nullable `base_yard_id` referencing the shared MBT yard UUID while
  preserving the existing yard-code projection;
- add positive optimistic `revision` and audited capability history;
- retain the existing `bin_service_enabled` only as a derived compatibility
  value equal to `(truck_type = 'bin')`, constrain Bin slot capacity positive
  and Flatbed slot capacity zero; and
- update supported `dispatch_truck_bin_types` in the same locked revisioned
  command.

The migration leaves every current truck operationally unchanged as a
flatbed. It must not infer Bin from plate, Samsara vehicle, capacity, or prior
load history.

Seed or configure the minimum versioned service templates for the pilot:

- initial empty-bin delivery;
- empty-bin final pickup/return;
- loaded-bin pickup, dump, and return;
- bin exchange/swap.

Templates remain draft until their ordered steps and evidence requirements are
complete. Activated or used versions are immutable; changes clone a new draft.

### 6.3 Contract-leg ordering and projection

Extend `mbt_service_visits` with nullable `predecessor_service_visit_id` and
immutable predecessor/sequence history. Add a composite candidate key on
`(contract_id, service_visit_id)` and composite foreign key
`(contract_id, predecessor_service_visit_id)` so a predecessor cannot cross
contracts. Enforce one root, at most one active direct successor per predecessor,
and at most one visit per contract in `ready`, `planned`, `in_progress`, or
`evidence_pending`. Service commands validate acyclicity under a contract-level
lock. A later visit is rejected from entering `ready`; feed filtering is not
the invariant.

Add a server-owned front-leg query/projection keyed by contract and selected
plan date. It returns only eligible `ready` visits; it does not persist a stale
`is_front` flag. The projection includes a versioned contract/visit/capability
snapshot and a read-only compact timeline, while the Dispatch assignment key
remains the service-visit UUID/reference.

Plan snapshots freeze the truck type/revision, supported bin sizes, slot
capacity, shared-yard identities, leg predecessor/revision, and materialized
mandatory physical stops used at confirmation.

### 6.4 Reconciliation and variance evidence

Add immutable manual comparison batches and rows for:

- asset movements;
- dump receipts/weights;
- calculated route distances/rate bands;
- MBT contract billing lines; and
- MBBS cross-charge allocations.

A comparison result is `matched`, `open_variance`, `accepted_application`,
`accepted_manual`, `corrected_application`, `corrected_manual`, or
`evidence_only`. Every terminal non-match requires actor, audit note, decision
time, and references to both immutable snapshots.

Resolution never edits an original movement, distance, receipt, or approved
billing version. Application corrections append a reversal/new movement,
amendment, corrected evidence record, or new billing version as appropriate.

## 7. Unified CSV, NetSuite SpreadsheetML, and manual import contract

All resources use one server-owned workflow:

1. Download a versioned UTF-8 CSV template. Customer import additionally
   accepts the bounded NetSuite SpreadsheetML shape described above.
2. Upload to **Preview**. The server streams and bounds the file, validates
   headers/types/references/duplicates, normalizes rows, and stores a batch.
3. Display valid/invalid counts and safe row-level errors. Preview has no domain
   side effects.
4. Apply the exact preview with its batch ID, normalized hash, expected target
   revisions, audit reason, and `Idempotency-Key`.
5. Revalidate under row/advisory locks and commit the entire batch atomically.
6. Return stable created/updated/unchanged/conflicted counts and entity IDs.

Default bounds are 20 MiB, 50,000 logical rows, 200 columns, 4,000 characters
per cell, and a bounded error report. These defaults are configurable only
downward without a spec revision. Reject NUL/control characters, invalid UTF-8,
duplicate/unknown headers, unsafe numbers, and spreadsheet formula prefixes in
exported reports. CSV quoting follows RFC 4180. Customer `.xls` acceptance is
content-based and limited to the XML Spreadsheet namespace; reject binary OLE,
ZIP/XLSX, DTD/entity expansion, formulas, external links, and macros rather than
trusting a filename or MIME header.

The apply command is all-or-nothing. A database error at any row leaves zero
domain rows from that batch. Exact retry replays the receipt; the same key with
changed batch/hash/reason conflicts. Concurrent batches touching the same
natural keys serialize and one receives an explicit stale/conflict result.

Manual create/edit routes call the exact per-row command used by batch apply.
They require expected revision, reason, and idempotency key. Deactivation is
preferred over deletion; a referenced or historically used record cannot be
deleted.

### 7.1 Resource templates

| Resource | Required identity and notable fields |
|---|---|
| Customers | Positive `customer_internal_id`; entity/legal/display names; active; CAD/source currency; source modified time/version; account ID. The observed NetSuite SpreadsheetML aliases `Internal ID`, `Name`, `Primary Subsidiary`, `Status`, `Phone`, and `Email` are supported. Optional address/contact/subsidiary files use stable NetSuite external IDs. |
| Local items | Immutable item code; display/description; category; pricing mode; optional bin type and applicability; active. Never price/UOM/currency. |
| Materials | Stable material code; display/description; active. |
| Dump sites | Stable site code, address/contact/coordinates, active, plus material code, accepted state, scale-ticket requirement, and notes. |
| Bin assets | Asset code; optional unique QR/barcode; bin type; home yard; condition; optional tare; active/maintenance; initial status/location. |
| Rate cards | Header/version files plus distance bands, components, dump tariffs, and deposit rules. Monetary cells are integer cents; distance is integer metres. |

Yards are deliberately not an MBT import resource. Asset and dump/rate imports
reference the shared Dispatch yard by exact yard code or location ID; unknown
or ambiguous values fail preview.

Customer import supports one required customer CSV or the observed NetSuite
SpreadsheetML customer worksheet, plus optional address, contact, and
subsidiary CSV files in the same batch. A customer may be imported without an
address for historical lookup, but cannot be selected for a new contract until
an active service address and local site profile exist.

Rate-card CSV is a multi-file atomic batch:
`rate_cards.csv`, `distance_bands.csv`, `components.csv`,
`dump_tariffs.csv`, and `deposit_rules.csv`. Manual UI builds the same draft
aggregate. Import never edits an active or used version; it creates a new draft
that must pass validation and a separate audited activation command.

Use the existing production dependency set and CSV capabilities where they meet
these bounds. A new parser dependency requires a dependency/security/license
review and an appended spec decision before installation.

## 8. API and UI contract

All private responses use `Cache-Control: no-store`. Routes require live
session authorization; browser-provided roles, IDs, revisions, totals, and
calculated prices are never trusted.

### 8.1 Configuration and import APIs

```text
GET  /api/mbt/config/imports/:resource/template
POST /api/mbt/config/imports/:resource/preview
POST /api/mbt/config/imports/:resource/:batchId/apply
GET  /api/mbt/config/imports/:resource/:batchId

POST /api/mbt/customers/sync
GET  /api/mbt/customers/sync/runs
GET  /api/mbt/customers/sync/runs/:runId
GET  /api/mbt/customers/conflicts
POST /api/mbt/customers/conflicts/:conflictId/resolve
GET  /api/mbt/customers/search

GET/POST/PUT /api/mbt/config/local/items...
GET/POST/PUT /api/mbt/config/materials...
GET/POST/PUT /api/mbt/config/dump-sites...
GET/POST/PUT /api/mbt/config/service-templates...
GET/POST/PUT /api/mbt/config/rate-cards...
POST         /api/mbt/config/rate-cards/:versionId/validate
POST         /api/mbt/config/rate-cards/:versionId/activate
```

The shown `GET/POST/PUT ...` families are a naming contract, not permission to
build generic CRUD. Each command receives an exact allowlisted body and has its
own role/revision/idempotency/audit rules.

The established `GET/PUT /api/dispatch/setup` contract remains the shared yard
and truck configuration seam. Its truck projection adds `truckType`,
`revision`, `binSlotCapacity`, and `supportedBinTypeCodes`; its own-yard shape
remains compatible. Any type/base-yard/BIN-capability change requires expected
revision and preserves existing fleet activation/conflict checks. A legacy
payload omitting every Phase 3 capability field is treated as a legacy-field
partial update and preserves the stored capability revision; it can never
default an existing truck back to Flatbed or clear its supported sizes.

### 8.2 Operational APIs

```text
GET/POST/PUT /api/mbt/frontdesk/quotes...
POST         /api/mbt/frontdesk/quotes/:quoteId/issue
POST         /api/mbt/frontdesk/quotes/:quoteId/accept
POST         /api/mbt/frontdesk/quotes/:quoteId/convert
GET/POST/PUT /api/mbt/frontdesk/contracts...
POST         /api/mbt/frontdesk/contracts/:contractId/visits

GET/POST/PUT /api/mbt/assets...
POST         /api/mbt/assets/:assetId/movements
POST         /api/mbt/assets/:assetId/corrections
GET          /api/mbt/assets/:assetId/timeline

GET          /api/mbt/reconciliation/batches...
POST         /api/mbt/reconciliation/batches/:batchId/resolve

GET/POST     /api/mbt/billing/cases...
POST         /api/mbt/billing/cases/:caseId/calculate
POST         /api/mbt/billing/cases/:caseId/review
POST         /api/mbt/billing/cases/:caseId/approve-local
```

The current Dispatch and Driver endpoints remain the public integration seams.
Do not create a second planner or second PWA. Extend their versioned BIN
snapshots/manifests while preserving old versions for cached clients.

### 8.3 Pages

- `/mbt/config`: Customer Sync & Import, Local Items, Materials & Dump Sites,
  Service Templates, Rate Cards, and future NetSuite readiness tabs.
  Customer Sync & Import presents **Sync from NetSuite** as the primary normal
  action and **Upload NetSuite export** (`.csv` or supported XML `.xls`) as the
  bootstrap/recovery action; it clearly displays source/provenance/freshness.
- `/mbt/frontdesk`: customer/site search, quote, contract, and visit creation.
- `/mbt/assets`: asset registry, current state, timeline, movement/correction,
  import, and reconciliation.
- Existing Dispatch Settings: the existing Own Yards tab manages the shared
  yards, and the existing Trucks tab manages Flatbed/Bin type, BIN slot
  capacity, and supported bin sizes. No duplicate MBT fleet/yard page exists.
- Existing Dispatch planner: a separate BIN contract-leg pool/card/filter,
  contract timeline, and versioned visit snapshot.
- Existing Driver PWA: versioned BIN action cards, scan/evidence requirements,
  and the established offline status/sync experience.
- `/mbt/billing`: MBT contract and MBBS cross-charge local shadow queues,
  calculation evidence, variance review, and local approval.

Every table/list keeps keyboard focus during refresh, uses server pagination,
has accessible labels/statuses, and never re-renders an active input on each
keystroke. English and Chinese labels/errors are required for Driver-visible
BIN workflow text.

## 9. Operational behavior

### 9.1 Customer synchronization and import

The canonical apply service accepts normalized customer aggregates, not raw
NetSuite/CSV/XML payloads. A source adapter produces customer, subsidiary,
address, and contact projections with stable external identities, provenance,
source time/version, and canonical hash.

On a direct-access mirror source:

1. Claim one lease per account/subsidiary/sync kind.
2. Increment from the durable `(source_modified_at, netsuite_id)` cursor so
   equal timestamps across page boundaries cannot lose rows.
3. Fetch through a narrow read-only adapter. An allowlisted SuiteQL query may
   use HTTP POST because it is a query, but no transaction/record mutation path
   or generic write client is available to the adapter.
4. Normalize and hash each bounded page.
5. Under one database transaction, compare source version/hash, create
   conflicts where required, apply safe rows, project Returns rows, append
   durable `customer-master/v1` events, and advance the page cursor.
6. Publish/kick delivery only after commit. A rollback emits nothing.
7. Mark a full-reconciliation record inactive only after every page succeeds
   and the source explicitly proves that the snapshot is complete and nonempty.

A failed, empty, truncated, unauthenticated, rate-limited, timed-out, or
malformed run preserves the last valid canonical and Returns snapshots and
does not advance the high-water mark.

On a mirror consumer, the signed event/snapshot contract calls the same apply
service and source-version rules. It never attempts direct NetSuite access.
Exact source-event replay is a no-op. Cursor expiry triggers bounded full
reconciliation, not deletion or an in-memory-only reset.

The scheduler is lease-backed and disabled until `mbt_customer_sync` is
explicitly enabled. The initial operational cadence is the existing safe
six-hour customer refresh cadence plus an off-hours full reconciliation;
manual Sync now remains available. Real cadence/rate limits are recorded in
deployment configuration, not hardcoded in domain logic.

### 9.2 Front Desk

Front Desk searches the canonical customer projection. A new quote requires:

- an active customer in the approved pilot/subsidiary scope;
- an active canonical address and active local site profile;
- an active bin type and service template version;
- an active local rate-card version effective on the service date; and
- a server-owned immutable distance snapshot or an audited manual-distance
  override.

Quote states are `draft -> issued -> accepted -> converted`, with explicit
cancel/expiry paths. Amounts are calculated on the server from integer metres,
integer cents, the exact rate version, service/bin type, selected options, and
tax policy. Browser totals are display-only.

One exact accepted-quote conversion atomically creates:

- one contract and immutable customer/site/rate/template snapshots;
- one initial delivery visit as the contract's front leg;
- one tentative return visit whose explicit predecessor is the delivery and
  whose due window rebases from actual delivery completion;
- one local-only MBT contract billing case; and
- command receipt/audit evidence.

Concurrent or exact repeated conversion cannot create duplicates. Later
customer, site, template, or rate edits do not rewrite the contract snapshot.
An extension/amendment may move only an unstarted return visit and creates an
append-only contract amendment. Front Desk shows the whole commercial contract
timeline; only the server-derived current front leg can enter Dispatch.

### 9.3 Asset management

The operational asset page exposes current state and the complete append-only
timeline. Search may use exact/prefix asset code, QR, barcode, bin type, yard,
status, maintenance state, or contract/site.

Normal movements follow template-owned transitions. An Admin/Dispatcher
manual movement requires expected asset sequence/current state, occurred time,
reason, source, and destination. A correction references the incorrect
movement and appends a compensating movement; it never edits or deletes the
original.

Opening asset CSV registration requires an explicit initial status/location.
The initial manual reconciliation compares every imported asset against the
manual opening inventory before asset operations are enabled.

### 9.4 BIN Dispatch

The unassigned BIN pool shows one card per eligible contract, but that card's
assignable identity is only the current front service leg. It never assigns the
contract itself. The card header and badges make this explicit, for example:

```text
BIN · Contract MBT-000123 · Leg 1
Deliver empty 14YD
12441 -> Customer site
Next: Final pickup (tentative, not dispatchable)
```

Selecting the card opens a split detail view: current leg requirements and
route/stops first, followed by a read-only contract timeline. Completed legs
are visually complete, the front leg is highlighted, and later legs are grey
and locked. Search matches contract number, customer, address, action, asset,
and visit reference. Only the highlighted ready front-leg card is draggable.

The feed returns a versioned BIN snapshot that includes contract identity and
timeline summary; front-leg/predecessor status; customer/site; service action;
visit/template revisions; bin type; exact expected/incoming/outgoing assets;
material/dump; evidence requirements; scheduled window; billing ownership;
pilot scope; and the mandatory ordered physical stops.

Dragging the card into a load assigns the complete front leg. Its physical
stops are materialized into the current load preview using the same physical-
visit styling and timing model as other stops. Same-address visits may group
only when precedence, capacity, asset identity, and evidence ownership remain
unambiguous. Dispatch cannot place parts of one leg on different trucks/loads.

Plan confirmation rechecks, under locks:

- visit is still the contract's sole front leg, still ready for the plan date,
  and its predecessor/visit/template snapshot revisions are current;
- truck type is `bin`, its compatibility projection is enabled, it supports
  the exact bin type, and its BIN slot/weight capacity is sufficient;
- every referenced origin/return own yard resolves to the shared yard record;
- driver/truck/plan date are pilot-authorized;
- dump site accepts the material when applicable;
- every exact asset is in an action-appropriate state and not reserved by
  another active visit; and
- ordered stops/steps satisfy the service template.

Plan confirmation, exact reservation, visit `ready -> planned`, front-leg
identity, complete mandatory stop group, and stored truck/yard capability
snapshot commit atomically. A failure rolls all of them back. Editing an
unstarted visit releases/transfers reservations transactionally. A started
visit cannot be silently reassigned or rewritten; an approved recovery command
requires a Dispatcher audit note and preserves prior snapshots.

After durable completion/cancellation and evidence validation, the planner
removes the finished current leg, recomputes the contract front leg, and emits
one order-pool refresh. The next leg appears only when it separately reaches
`ready` for the selected date. Refresh/retry cannot show both legs together.

BIN cards never expose ordinary order allocation, split, dependency,
fulfillment, receiving, or SCM controls. Existing SO/TO/PO/VRMA/custom plans
must retain their behavior and save-time performance.

### 9.5 Driver PWA BIN execution

Issue a new versioned Driver manifest/job shape containing the complete frozen
BIN snapshot. Old non-BIN manifests remain compatible. A server-configured
minimum PWA version is required before releasing BIN work; an outdated client
must reopen/update before it can start the job.

The established local-first rule applies:

1. Download and durably store the manifest, materialized BIN data, requirements,
   and grant before enabling the action.
2. Persist event and Blob evidence locally before advancing the UI.
3. Preserve device occurrence time separately from server receipt/application
   time.
4. Attempt quiet sync; exact retry returns the existing outcome.
5. If the visit/asset/template snapshot changed unsafely, retain all evidence
   and enter review rather than attaching it to another stop/asset.

Minimum pilot requirements are:

- delivery: scan/confirm exact outgoing asset and required placement photos;
- pickup: scan/confirm the asset at the customer and required condition/load
  photos;
- exchange: independently scan and evidence outgoing and incoming assets;
- dump: record stable dump site/material, receipt/ticket, weight or quantity,
  UOM, subtotal, tax, total, currency, and receipt photo/hash; and
- every step: required notes/signatures/photos from the immutable template.

Completion is one operational transaction containing the driver job record,
event acknowledgement, durable evidence references, visit/step transitions,
asset movement/state, actual timestamps, and billing trigger identity. Evidence
pending upload cannot satisfy a requirement. Failure injection after any write
boundary must roll back the whole operational application; the locally retained
event remains retryable.

Disabling new Driver execution blocks new BIN materialization/start but must
not prevent an already issued valid manifest from uploading evidence and
reaching authorized review. Offline BIN work performs no phone GPS request,
NetSuite operation, Samsara duty/DVIR write, or stale truck assignment.

### 9.6 Local billing and cross-charge shadow

Calculation creates a draft billing version and all calculated lines in one
transaction before approval. The version freezes customer/contract/visit,
local item revision, rate version, raw metres, band, receipt, quantities,
amounts, tax, and calculation explanation. Approval then makes that complete
version immutable.

MBT contract billing supports the activated local rate graph: transport,
rental, extension, exchange, pickup, surcharge/discount, dump customer charge,
and locally captured custom price. Actual dump receipt cost is retained
separately from the customer tariff; margin is their exact difference.

MBBS cross-charge generation uses completed qualifying physical loads and the
source design's deduplication rules:

- SO: once per root SO and physical load; split children on the same load count
  once;
- TO: once per root TO globally, not again on a later load;
- PO and VRMA: once per root and physical load, sharing one non-SO fee pool when
  they belong to the same load; and
- allocation: deterministic sorted roots, exact cent conservation, and the
  final remainder assigned by the documented stable order.

The BIN contract flow and MBBS cross-charge flow are separate case sources; a
BIN visit is not assumed to be a cross-charge source. Exact retry or concurrent
generation produces the same cases/lines without duplicate notifications.

Both billing types stop at local approval. Database constraints and tests must
prove no outbox, Sales Order chain, deposit task, posting state, or NetSuite
mutation is produced.

### 9.7 Manual comparison and variance resolution

Manual records are uploaded/entered as separate immutable comparison evidence.
The application computes a comparison; it never treats the manual file as an
instruction to rewrite operational truth.

Required comparisons are:

- exact asset ID, before/after status and location, truck, driver, visit, and
  occurrence time for every pilot movement;
- ticket, dump site, material, weight/quantity, UOM, subtotal, tax, total, and
  currency for every dump receipt;
- raw origin/destination, provider, calculated metres, selected band, and
  amount for every billed trip; and
- every quantity, unit amount, net, tax, total, allocation, and deduplication
  key for every pilot billing/cross-charge line.

An open variance blocks pilot acceptance. Any rate-band difference or monetary
difference is a blocker until corrected or explicitly resolved. A distance
difference greater than the larger of 2 km or 5% requires an audit note even
when it stays in the same band.

## 10. Tier 3 failure model

| Failure | Required detector |
|---|---|
| NetSuite or CSV creates two identities for one customer | Positive internal-ID key, provenance/version rules, property and integration tests |
| A customer page boundary loses equal-timestamp rows | `(modified_at, internal_id)` cursor property tests |
| Empty/failed sync erases usable customers | Full-sync completeness guard, transaction test, Returns parity test |
| Canonical and Returns customer writers diverge | Single-writer cutover guard, dual-read parity report, legacy harness |
| Current SpreadsheetML loses/mutates the bare ampersand row | Synthetic malformed-text fixture, preview warning, round-trip property test |
| Malicious workbook executes/expands content | Content sniffing, no DTD/entities/formulas/links/macros, size/node bounds |
| CSV/manual paths enforce different rules | Shared command tests and response-contract comparison |
| A batch partially imports | Transaction/failure-injection tests and before/after checksums |
| A custom item weakens protected concepts or owns price twice | DB constraints, server policy tests, mutation tests |
| Dispatch and MBT create divergent copies of the four own yards | Unique location/code bridge, single-writer API contract, projection parity test |
| An existing truck becomes BIN-capable during migration | Flatbed backfill/default and exact before/after fleet capability assertions |
| Truck type disagrees with BIN capacity/supported sizes | DB/service invariants, Dispatch Settings API/browser tests |
| An asset exists without sequence-1 movement/state | Deferred DB invariant and transaction integration test |
| Two visits reserve the same asset | Row-lock race repeated at least 50 times |
| A used rate version changes | Database immutability trigger and repository/API tests |
| BIN is treated as SO or runs ordinary side effects | Dispatch contract test and exact legacy-state before/after checks |
| Dispatch exposes the whole contract or a later leg | Contract-chain/front-leg query tests and browser card/timeline assertions |
| One leg is split across trucks or loses a mandatory stop | Plan-schema constraint, assignment transaction, route precedence tests |
| Driver retry duplicates movement/evidence/billing | Durable event idempotency, concurrent offline retry test |
| Driver receipt time replaces offline occurrence time | Explicit three-time assertions in online/offline tests |
| Incomplete evidence completes a visit | Requirement transaction and partial-upload tests |
| Kilometres are rounded before band selection | Raw-metre boundary unit/property mutants |
| Cross-charge allocation loses/duplicates cents | Conservation/permutation property tests |
| Local approval creates external work | DB trigger, transport spy, outbox/chain count assertions |
| A gate unintentionally activates another area | Feature-state matrix and runtime/predeploy tests |
| Existing Dispatch/Driver/Returns/SCM behavior regresses | Full explicit legacy harness and browser baseline |
| A claimed P3 gauntlet silently runs P1 | Dedicated P3 gauntlet contract test |

## 11. Frozen executable scenarios

Tests may add stricter assertions, but implementation must not weaken these
scenarios without an appended spec revision approved before the behavior change.

### Customer and import scenarios

**P3-F01 — NetSuite full and incremental customer sync.** A read-only fixture
imports customer, subsidiary, address, and contact aggregates. Equal modified
times spanning pages are complete, exact replay is a no-op, and cursor/state
advance only with the committed page.

**P3-F02 — Customer source ordering and conflict.** Newer versions replace
older versions; older input cannot overwrite current; equal version/equal hash
does nothing; equal version/different hash creates one open conflict and
preserves current data.

**P3-F03 — Failed snapshot preservation.** Empty, partial, malformed, timed-out,
or lease-lost full synchronization keeps the prior canonical and Returns
snapshots and cannot inactivate records or advance a cursor.

**P3-F04 — Source/consumer compatibility.** The source publishes committed
`customer-master/v1` events and a bounded snapshot; a consumer replays them
without direct NetSuite access. Existing `netsuite-mirror/v1` fixtures and
cursors are unchanged.

**P3-F05 — Returns compatibility and cutover.** Active canonical customers
project to the exact established Returns response/search shape. Inactive
customers remain canonical history but leave the active projection. During
dual read, parity is reported by internal ID; after cutover only the canonical
projection writer is active.

**P3-F06 — Current workbook preview.** A synthetic fixture matching
`MBT_customer_20260803.xls` previews the ten observed headers, explicit account/
subsidiary/currency/as-of defaults, status/scope skips, incomplete entity
numbers, ignored fields, and a recovered data-node ampersand. Preview writes no
customer rows.

**P3-F07 — Current workbook apply and retry.** The approved normalized hash
imports unique positive internal IDs atomically with `csv_bootstrap`
provenance. Exact replay returns the stored result; changed data under the same
key conflicts; eventual live NetSuite data supersedes bootstrap fields while
local site profiles survive.

**P3-F08 — Hostile/invalid imports.** Invalid encoding, oversized input,
duplicate IDs/headers, extra cells, unknown required references, unsafe numbers,
binary `.xls`, formulas, DTD/entities, links, and structurally malformed XML
fail before any domain mutation.

**P3-F09 — Local item setup.** The five protected concepts survive migration
and cannot change identity. Admin may manually/CSV create, edit, deactivate,
and retry custom items through one validator. No item requires a NetSuite ID or
stores money/UOM/currency.

**P3-F10 — Shared yards, fleet, and other master setup.** The four established
Dispatch own yards project exactly once into `mbt_yards` with their existing
IDs/details and remain editable only through Dispatch Settings. Every existing
truck remains Flatbed. Dispatcher can add/update a Bin truck with required base
yard, slot capacity, and supported sizes. Manual/CSV material, dump site,
acceptance, and service-template setup validates exact references, coordinates,
steps, and evidence requirements. A legacy truck edit omitting new fields
preserves its current type/capabilities. Inactivation preserves history.

**P3-F11 — Asset registration/import.** Each valid asset creates exactly one
asset, sequence-1 movement, current state, audit, and receipt atomically.
Duplicate asset/QR/barcode, missing yard/bin type, or injected failure creates
none.

**P3-F12 — Rate-card setup.** Manual/multi-CSV import creates a draft graph.
Activation rejects gap/overlap, unsafe cents/metres, missing local references,
invalid dates/units/currency, and conflicting active versions. Used versions
are immutable and changes clone a new draft.

### Operational scenarios

**P3-F13 — Front Desk exact conversion.** An active pilot customer/address/site
and valid local configuration produce an exact-cent quote. Accepted conversion
creates one contract, initial front delivery leg, explicitly dependent
tentative return leg, and local billing case; concurrent/exact retry creates no
duplicates or external work.

**P3-F14 — Snapshot stability and amendment.** Later customer/rate/template/site
changes do not rewrite an existing contract/visit. A revision-checked extension
amends only an unstarted return; stale/concurrent requests leave no partial
change.

**P3-F15 — Contract front-leg isolation.** For one contract, only its current
ready front leg appears as one first-class BIN card for the selected date. The
whole contract and later tentative/ready-looking legs are not assignable. The
card shows the contract timeline and complete route, never appears as SO, and
exposes no ordinary allocation, dependency, SCM, fulfillment, or receiving
behavior. Unknown order types fail closed.

**P3-F16 — Atomic Dispatch leg plan/reservation.** A shared-yard route,
type-Bin compatible truck, driver, complete mandatory stop group, and exact
asset confirm plan, reservation, truck/yard snapshot, front-leg identity, and
visit state together. Fifty competitors for one asset yield one winner.
Failure after reservation rolls everything back; ordinary plan state is
unchanged. A Flatbed truck is always rejected for BIN work.

**P3-F17 — Safe leg advancement/edit/recovery.** An unstarted BIN leg can move
between loads with transactional whole-leg/reservation transfer, but cannot be
split across trucks or lose mandatory stops. A started leg requires a separate
audited recovery and retains original snapshots/evidence. Completion advances
the next leg exactly once; current and next never coexist in the unassigned
pool.

**P3-F18 — Driver online initial delivery.** Assigned current PWA receives the
frozen BIN job, scans the exact 14YD asset, captures all photos, and completes
one visit/movement from yard/reserved through truck to customer. Wrong asset or
pending evidence blocks completion.

**P3-F19 — Driver offline delivery/reopen/sync.** The complete BIN manifest and
Blob evidence survive airplane mode and restart. Reconnection applies device
occurrence times once, with separate receipt/application times and zero GPS,
Samsara, NetSuite, or generic order side effects.

**P3-F20 — Driver manifest change review.** Unsafe visit/asset/template change
after manifest issuance retains uploaded evidence and enters review; it cannot
attach to a new asset/stop automatically. Safe exact retries replay.

**P3-F21 — Loaded pickup and dump.** The driver scans the customer asset,
captures pickup evidence, visits an accepting dump, records a complete receipt,
and returns/moves the asset per template. Required receipt/photo upload failure
leaves the visit evidence-pending and retryable.

**P3-F22 — Exchange.** Same-bin and swap exchange flows keep incoming/outgoing
asset identities distinct, require both scans/evidence, and create the exact
template-owned movement sequences without duplicate reservations.

### Reconciliation and billing scenarios

**P3-F23 — Movement comparison.** Every pilot movement compares to a manual
record by asset/state/location/truck/driver/visit/time. Mismatch opens a
variance. Resolution cannot rewrite the original ledger.

**P3-F24 — Receipt and distance comparison.** Exact receipt fields and raw
server metres/band/charge compare to manual evidence. Any money/band mismatch
blocks; a distance threshold exception requires a note and retained snapshots.

**P3-F25 — MBT local contract calculation.** Locked rate/visit/receipt/distance
evidence produces deterministic transport, rental, extension, exchange,
pickup, surcharge/discount, dump, tax, and total lines. Dump customer charge,
actual cost, and margin remain separate.

**P3-F26 — MBBS cross-charge rules.** Representative completed SO, split-SO,
TO, PO, and VRMA physical loads generate exact deduplicated cases and
cent-conserving deterministic allocations under the defined keys.

**P3-F27 — Local approval only.** Calculation writes all draft lines before one
immutable approval. Exact/concurrent retry returns the same version. Both MBT
and MBBS cases create zero chain, outbox, deposit, posting attempt, notification
duplicate, or NetSuite transport call.

**P3-F28 — Audited variance correction.** A charge/evidence variance is resolved
by an immutable decision and, when needed, an amendment/reversal/new billing
version. The original evidence and amount remain queryable.

**P3-F29 — Independent gates and recovery.** Every capability defaults closed
and requires all root/specific/pilot conditions. Enabling one does not enable
another. Closing gates blocks new work while allowing authorized evidence
drain/review.

**P3-F30 — Full non-regression.** All established Dispatch, Driver, Returns,
Smart SCM, auth, return, and ordinary order harnesses remain green with Phase 3
closed and during an isolated pilot. No measurable ordinary Dispatch save-time
regression exceeds the frozen baseline tolerance.

## 12. RED to GREEN implementation packets

Each packet is independently resumable. Before implementation, append its exact
approved scenario/test mapping to `docs/mbt/03-executable-spec.md` (create that
file for Phase 3), record a focused RED at the intended assertion, freeze the
assertions, implement the narrowest GREEN behavior, and run the packet plus
critical regressions. Do not combine packets merely because their migrations
share a number.

### P3.0 — Spec, baseline, and safety inventory

- Prerequisite: explicit user approval of this document.
- Freeze migrations/files/baseline commit, roles, flags, legacy harness count,
  current route contracts, current workbook structure/hash, and zero-posting
  database counts.
- Add the Phase 3 executable spec, RED/GREEN journal, and evidence skeleton.
- Exit: named tests and expected REDs are reviewed; no production/code behavior
  changes yet.

### P3.1 — Dedicated gauntlet, feature gates, and migration rehearsal

- RED: `infrastructure/p3-gauntlet-contract.test.js`,
  `integration/p3-feature-gates.test.js`, and
  `integration/p3-migration-upgrade.test.js` prove that current P3 incorrectly
  falls through to P1 and new flags/schema are absent.
- GREEN: dedicated P3 CI/predeploy/runtime/closed-write workflow, new flags,
  additive migrations, fresh plus representative schema-109 upgrade/rerun,
  bounded-lock rollback, and production-shaped closed-gate smoke.
- Exit: every flag is false, P3 cannot select P1 evidence, and representative
  pre-P3 data checksums are unchanged.

### P3.2 — Unified import foundation and current SpreadsheetML

- RED: `unit/master-data-csv.test.js`,
  `unit/customer-spreadsheetml.test.js`,
  `property/master-data-import.property.test.js`,
  `integration/master-data-import-foundation.test.js`, and concurrency/API
  tests cover P3-F06–P3-F08.
- GREEN: bounded streaming parsers, staged preview/hash, atomic/idempotent apply
  coordinator, safe reports, revision locks, current workbook mapping, and UI
  import component. Use only synthetic PII-free fixtures in Git.
- Exit: synthetic structurally equivalent 1,262-row scale test passes; an
  authorized manual preview of the real workbook records only aggregate counts,
  hash, warnings, and no row values or domain writes.

### P3.3 — Canonical customer sync, mirror, and Returns cutover

- RED: `integration/customer-sync.test.js`,
  `concurrency/customer-sync-races.test.js`,
  `property/customer-sync.property.test.js`, and
  `integration/customer-consumer-compatibility.test.js` cover P3-F01–P3-F05
  and P3-F07.
- GREEN: narrow NetSuite source adapter, canonical apply service, leases/cursor,
  conflicts, `customer-master/v1`, consumer reconciliation, CSV bootstrap,
  Returns projection/dual-read parity, scheduler ownership, APIs, and UI.
- Exit: two full fixture reconciliations and one incremental are exact; Returns
  response contracts/harnesses pass; `netsuite-mirror/v1` is unchanged; all
  transport mutation spies remain zero.

### P3.4 — Local reference data, custom items, and templates

- RED: `integration/shared-dispatch-mbt-yards.test.js`,
  `integration/dispatch-truck-types.test.js`,
  `concurrency/dispatch-truck-capability-races.test.js`,
  `e2e/p3-dispatch-settings.spec.js`, and local-item/master repository/API/
  browser tests cover P3-F09 and P3-F10, including earlier LC scenarios and
  protected five-item behavior.
- GREEN: manual/CSV local items; exact relational projection of the four
  existing Dispatch yards; shared Dispatch truck type/capability schema and
  Settings UI; materials; dump sites/acceptance; conditions; versioned
  template/steps/requirements; audit, deactivation, and readiness UI. There is
  no second yard/truck registry or MBT yard import screen.
- Exit: one complete pilot-local graph is configured without NetSuite mappings;
  existing trucks remain Flatbed unless explicitly changed; one Bin truck can
  be safely registered; closed operational gates still prevent a contract/
  plan/Driver mutation.

### P3.5 — Asset registry and operations

- RED: `integration/asset-registration.test.js`,
  `concurrency/asset-registration-races.test.js`, API/browser tests, and all
  existing movement/reservation suites cover P3-F11/P3-F23.
- GREEN: import/manual registration transaction, list/timeline, revisioned
  attributes, operational movement/correction, reconciliation export/import,
  and granular gate.
- Exit: opening asset list reconciles with manual evidence and every asset has
  exact ledger/state invariants; existing asset service coverage remains green.

### P3.6 — Rate setup and pure calculators

- RED: `unit/local-rate-calculator.test.js`,
  `property/local-rate-calculator.property.test.js`,
  `integration/rate-card-configuration.test.js`, concurrency/API/browser tests,
  and existing rate lifecycle tests cover P3-F12/P3-F24/P3-F25.
- GREEN: draft graph/manual/multi-CSV commands, validation/activation/cloning,
  raw-metre band calculation, dump cost/customer tariff separation, and exact
  calculation explanations.
- Exit: boundaries and money properties pass at least 1,000 generated cases;
  used-version DB immutability is unchanged; local activation has no NetSuite
  mapping dependency.

### P3.7 — Front Desk vertical slice

- RED: `integration/frontdesk-workflow.test.js`,
  `concurrency/frontdesk-races.test.js`, and `e2e/p3-frontdesk.spec.js` cover
  P3-F13/P3-F14.
- GREEN: customer/site search/edit, quote calculator/states, conversion,
  contract snapshot/amendment, initial/tentative visits, local billing case,
  roles/gates, accessible UI.
- Exit: concurrent confirmation yields one contract/visit set/case and zero
  posting artifacts; customer/rate edits cannot rewrite snapshots.

### P3.8 — Current Dispatch BIN integration

- RED: `contracts/mbt-p3.schema.test.js`,
  `integration/bin-contract-front-leg.test.js`,
  `integration/bin-dispatch-enabled.test.js`,
  `concurrency/bin-dispatch-enabled-races.test.js`,
  `concurrency/bin-leg-advancement-races.test.js`,
  `e2e/p3-bin-dispatch.spec.js`, plus disabled BIN and ordinary Dispatch
  regression suites cover P3-F15–P3-F17.
- GREEN: server-derived contract front-leg query, versioned BIN snapshot/feed/
  cards and read-only contract timeline, complete mandatory-stop projection,
  fail-closed canonical type, shared-yard and type-Bin capability validation,
  atomic whole-leg plan/reservation, safe edit/advancement, audited recovery,
  and pilot gate.
- Exit: 50-way reservation race has one winner; no generic order side effects;
  whole contracts/future legs never enter the pool; a leg cannot split across
  trucks/loads; ordinary plan correctness and bounded save-performance target
  pass.

### P3.9 — Driver PWA BIN online/offline execution

- RED: `integration/driver-bin-execution.test.js`,
  `concurrency/driver-bin-sync-races.test.js`,
  `property/driver-bin-event.property.test.js`, and
  `e2e/p3-driver-bin-offline.spec.js` cover P3-F18–P3-F22.
- GREEN: versioned job/manifest, full IndexedDB materialization, min-client
  gate, action-specific scans/evidence/receipt UI, dedicated atomic completion,
  safe review, quiet exact sync, English/Chinese text.
- Exit: online and airplane-mode/reload/reconnect scenarios have one movement/
  completion/evidence set and correct occurrence time; established Driver PWA,
  GPS, rest, photo, truck-switch, and ordinary-stop suites remain green.

### P3.10 — Reconciliation and local shadow billing

- RED: `integration/pilot-reconciliation.test.js`,
  `unit/local-billing-calculator.test.js`,
  `property/local-billing-calculator.property.test.js`,
  `integration/shadow-billing.test.js`, concurrency/API/browser tests cover
  P3-F23–P3-F28.
- GREEN: immutable comparison batches, variance workflow, MBT and MBBS case
  generators, draft version/line calculation, local approval, deterministic
  allocation, correction/amendment paths, billing UI.
- Exit: every calculator/allocation property passes 1,000 cases; concurrent
  generation/approval is exact; posting artifacts/transports stay zero.

### P3.11 — Automated end-to-end gauntlet

- Build a synthetic vertical slice: import/configure -> customer -> Front Desk
  -> front contract leg -> shared-yard/type-Bin Dispatch assignment -> Driver
  offline -> movement/receipt/distance -> next-leg advancement -> MBT billing,
  plus separate representative MBBS cross-charge loads.
- Run desktop Chromium, Pixel Chromium, and iPhone WebKit; serious/critical
  accessibility; failure injection; server restart; shuffled repetitions;
  production-shaped application image.
- Exit: one fresh `tools/mbt-gauntlet.sh P3` passes and
  `docs/mbt/evidence/P3.md` contains reproducible counts. This permits only
  `AUTOMATED COMPLETE / PILOT PENDING`.

### P3.12 — Controlled deployment and live pilot

- Requires separate deploy authorization, a fresh validated backup, exact
  accepted image, closed-gate migration/cutover, and named pilot allowlist.
- Activate in order: customer sync -> master imports -> asset operations ->
  Front Desk -> BIN Dispatch -> current Driver PWA -> local shadow billing.
- Run the live reconciliation playbook below. Never enable NetSuite writes.
- Exit: user accepts the pilot evidence and remaining variances are zero or
  explicitly resolved. Only then may Phase 3 be marked operationally complete.

## 13. Automated verification matrix

| Layer | Minimum Phase 3 evidence |
|---|---|
| Pure unit | Normalizers, parsers, state machines, rate bands, money, dedupe/allocation, manifest events |
| Property | At least 1,000 cases each for CSV round trip, customer cursor/order, rate boundaries, money conservation, allocation permutation, Driver event replay |
| PostgreSQL integration | Fresh/upgrade/rerun migrations, shared yard/truck invariants, front-leg chain/projection, DB constraints/triggers, atomic imports, source pages, asset ledger, visits, rates, billing, corrections |
| Concurrency | At least 25 repeated independent-client sync/import/conversion/approval races and a 50-client one-asset reservation race |
| Failure injection | Throw after each durable boundary; prove transaction rollback and retry from retained source evidence |
| Contract/API/auth | Versioned schemas, no-store, exact bodies, status/error codes, role matrix, idempotency/revision headers, legacy v1 compatibility |
| Browser/accessibility | Config/import, shared Dispatch yard/truck settings, Front Desk, BIN front-leg pool/timeline, assets, Driver offline, billing/review across desktop/mobile Chromium and mobile WebKit |
| Non-regression | Full explicit legacy 106-harness allowlist plus all existing MBT P1/P2/local-first tests and ordinary Dispatch/Driver baselines |
| Performance | Import bounded memory/time, customer page concurrency/rate limit, ordinary Dispatch save baseline, first Driver screen unaffected by BIN manifest download |
| Security/privacy | PII not copied to fixtures/logs/evidence; file attacks; XSS/CSV formula; roles; secret scan; dependency/license/audit |
| Mutation | Dedicated P3 persisted mutants; 100% killed; source hashes restored exactly |
| Deployment | Production-shaped image, external network/write spies, readiness, closed writes, backup/restore and kill-switch rehearsal |

New/changed Phase 3 server code must reach at least 95% lines/functions and 90%
branches. Pure critical calculators/parsers/state guards target 100% practical
branch coverage and direct mutation of each decision boundary. An unavailable
layer is reported as skipped with the exact reason; it cannot be silently
reclassified as passed.

The persisted P3 mutation set must include at least: name-based customer match,
missing cursor ID tie-breaker, empty sync success, canonical delete, event
before commit, lease bypass, partial import, duplicate identity acceptance,
stale revision acceptance, rate gap/overlap and used-version mutation, asset
lock bypass, existing-truck migration to Bin, flatbed accepted for BIN, truck
type/capability disagreement, duplicate shared yard, later contract leg exposed,
whole contract assigned, mandatory leg stop dropped, leg split across trucks,
BIN-to-SO fallback, generic side effects, Driver wrong-asset/evidence/time/replay
faults, kilometre pre-rounding, inclusive band maximum, lost allocation cent,
missing TO dedupe, pre-completion billing, and local approval enqueue.

The P3 gauntlet must have an explicit P3 branch in CI, mutation selection,
required migrations, predeploy inspection, runtime smoke, and evidence output.
Its contract test fails if any P3 stage falls back to P1/P2 silently.

## 14. Automated end-to-end acceptance

### E2E-A — Initial 14YD delivery

1. Admin previews/applies synthetic customer and master data through public APIs.
2. Front Desk selects an active customer/address/site, quotes, accepts, and
   converts a 14YD initial delivery plus dependent tentative return.
3. Dispatch sees only the delivery front-leg card, with `12441 -> customer`
   route and the locked future return in its timeline; it assigns one explicitly
   configured Bin truck, driver, and exact available asset. A Flatbed fixture is
   rejected.
4. Driver downloads the complete manifest, goes offline, starts, scans the
   correct asset, captures required photos, reloads, completes, and reconnects.
5. The event applies once using the offline occurrence time; the visit completes
   and the asset ends at the customer.
6. The tentative return is recalculated from actual delivery completion and
   becomes the next front leg only when independently ready for its plan date.
7. Local MBT billing calculates/approves exact expected lines with zero posting.

### E2E-B — Loaded final pickup through dump

1. The same contract creates a loaded pickup with accepting dump/material.
2. Dispatch/Driver execute customer -> dump -> yard using the exact asset.
3. Structured receipt and photo evidence survive offline retry.
4. Asset movements, raw distance/band, actual dump cost, customer charge, and
   margin reconcile exactly.

### E2E-C — Exchange

Execute both a same-bin exchange and an outgoing/incoming asset swap. Prove
independent scans, evidence, reservations, asset states, and billing with no
identity crossover.

### E2E-D — MBBS cross-charge shadow

Use separate representative completed physical-load fixtures containing a
root SO with split children, a TO repeated on another load, and PO/VRMA roots
sharing one load. Generate deterministic cases/allocations twice and prove
exact idempotency and zero posting.

## 15. Live pilot and manual evidence

Before enabling operations, customer evidence requires:

- successful preview of the current workbook with the recorded hash and only
  aggregate counts/warnings in the evidence report;
- zero duplicate/blank internal IDs after normalization;
- explicit resolution of skipped subsidiary/status rows;
- address hydration for the named pilot customers;
- two successful full canonical reconciliations and one incremental when live
  NetSuite/mirror connectivity is enabled; and
- canonical/Returns full outer-join parity by NetSuite internal ID with zero
  unexplained active-row mismatch.

Shared Dispatch-master readiness additionally requires:

- the exact four yard mappings `12441/15`, `3445/1`, `2967/28`, and `150/26`
  match the existing Dispatch values and relational MBT projection;
- zero duplicate/divergent yard codes, location IDs, addresses, or coordinates;
- every pre-existing truck remains type Flatbed immediately after migration;
- each pilot Bin truck was explicitly saved with base yard, slot capacity, and
  supported bin sizes in Dispatch Settings; and
- contract-pool parity proves one or zero eligible front legs per contract and
  zero future/whole-contract assignments.

The live operational pilot is at least 10 completed visits across at least two
operating days and includes initial delivery, loaded final pickup/dump,
same-bin exchange, and swap exchange across at least two bin sizes.

Reconcile 100% of pilot movements, receipts, billable distances, MBT billing
lines, and qualifying MBBS cases. Completion requires:

- zero unresolved asset state/location conflicts;
- zero missing or unattached Driver evidence;
- zero duplicate/missing visits, movements, receipts, billing cases, or lines;
- exact-cent agreement for every charge/allocation, or a resolved immutable
  variance whose accepted outcome the user approves;
- every rate-band difference resolved;
- all threshold distance differences documented;
- no unresolved Driver PWA sync/review/device failures; and
- zero Phase 3 NetSuite outbox, Sales Order-chain, deposit, posting attempt, or
  remote mutation activity.

The evidence report records run/batch/plan/manifest/case IDs and hashes, but
redacts customer contact/address values and photo/receipt content.

## 16. Deployment, rollback, and honest completion

Deployment is a separate authorized action. Source implementation completion
does not imply permission to migrate/restart/enable production.

Deployment order:

1. Build/test the exact image and tag the current healthy image for rollback.
2. Take, hash, catalog-validate, and restore-test a fresh database backup.
3. Apply forward migrations with every new gate closed.
4. Run P3 predeploy, established-route smoke, zero-write checks, and aggregate
   data checksums.
5. Enable only customer sync/import and complete parity.
6. Verify the four shared yards, Flatbed backfill, and explicitly configure the
   pilot Bin truck through Dispatch Settings.
7. Enable master data/imports and approve local readiness.
8. Enable asset operations and reconcile opening assets.
9. Enable Front Desk only for named customers/operators.
10. Enable BIN Dispatch only for named dates/Bin trucks/drivers/assets and
    verify front-leg-only pool output.
11. Require the current PWA and enable Driver execution.
12. Enable local shadow billing last.
13. Keep both NetSuite write gates false throughout.

Rollback/drain order preserves evidence:

1. Stop new Front Desk conversions and new Dispatch confirmations.
2. Continue sync/upload/review for already issued Driver manifests.
3. Drain in-progress visits and unsynced evidence.
4. Disable new Driver materialization after the drain preflight is clear.
5. Disable billing generation, then asset mutation.
6. Stop customer scheduling while retaining the last valid canonical and
   Returns snapshots.
7. Roll back the application image if necessary; additive compatible migrations
   remain. Use database restore only for migration/data corruption.

Never delete pilot contracts, visits, evidence, movements, imports, customer
conflicts, reconciliation decisions, or billing versions as rollback.

Completion labels are exact:

- `SPEC APPROVED`: the user approved this document.
- `AUTOMATED COMPLETE / PILOT PENDING`: one fresh P3 gauntlet is green, but live
  manual evidence is incomplete.
- `PILOT COMPLETE / LOCAL ONLY`: the manual gate is accepted and all external
  writes remained closed.
- Phase 3 must never be described as NetSuite-posting ready.

## 17. Approval checklist and restart protocol

User approval should explicitly confirm these decisions:

- NetSuite read sync is normal; CSV and the current SpreadsheetML `.xls` are
  bootstrap/recovery sources requiring real NetSuite internal IDs.
- The current workbook imports customer core only; service addresses must come
  from NetSuite sync or a companion address CSV.
- Five system local items stay protected while additional custom local items
  can be added manually/CSV with no local price field.
- Original design Phases 3–5 are combined into this local-only Phase 3.
- A separate `customer-master/v1` contract preserves existing
  `netsuite-mirror/v1` and Returns behavior.
- Existing Dispatch own yards `12441`, `3445`, `2967`, and `150` are the MBT
  yards; there is no duplicate MBT yard import/setup.
- `dispatch_trucks` remains the only fleet registry. Existing trucks backfill
  to Flatbed, and Dispatch Settings can explicitly add/configure a Bin truck
  with slot capacity and supported bin sizes.
- Dispatch displays/assigns only the contract's server-derived ready front leg;
  the whole contract and later legs remain read-only context until advanced.
- Materials/templates/truck capability are included because the requested
  end-to-end pilot cannot run without them.
- Pilot activation is allowlisted and staged; NetSuite writes remain disabled.
- The live gate is at least 10 visits/two days with 100% reconciliation.

After approval, every fresh-context implementation turn must:

1. Read this entire document and `docs/mbt/00-implementation-index.md`.
2. Read the exact packet's referenced existing migration/service/test files.
3. Check branch/worktree and preserve unrelated changes.
4. Run and record the packet's intended RED before production edits.
5. Implement only that packet, run focused GREEN and critical regressions, and
   append exact evidence/next action to the index.
6. Never claim the next packet, deployment, or live gate complete implicitly.
