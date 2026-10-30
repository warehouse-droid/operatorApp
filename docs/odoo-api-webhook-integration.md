# MBBS / MBT Odoo API and Webhook Integration

Version: 1.0 | Date: 22 October 2026 | Status: Proposed implementation specification

Audience: MBBS and MBT business owners, Odoo implementation team, application developers, and integration support.

This document specifies the interfaces required to replace the application's NetSuite integration with Odoo. It reflects the application source reviewed on the date above and the agreed change to MBT ownership. It does not describe an integration already deployed. All URLs under `/api/mbbs/v1` and `/api/integrations/odoo/v1`, event names, and transport schemas below are proposed custom contracts to implement.

The Odoo version, edition, hosting details, installed modules, and custom technical model names have not been verified. The business contract is version independent; the Odoo developer must complete the deployment confirmations in section 17 before implementation signoff.

## 1. Business outcome and confirmed decisions

The existing Node.js/PostgreSQL application remains the operational system for yard work, dispatch, drivers, and physical execution. Odoo replaces NetSuite as the ERP. Existing MBBS workflows remain available through an Odoo adapter; a change of ERP must not silently change when a receipt, fulfillment, return, approval, or stock movement occurs.

For MBT, Odoo owns order placement and the creation and revision of orders, order legs, and jobs. Odoo also owns prices, charges, deposits, billing, and accounting. The application receives the work, dispatches trucks and drivers, executes bin operations, records evidence, and reports outcomes to Odoo. It does not create another MBT order or calculate a second bill.

The customized Odoo BIN implementation is assumed to use the existing BIN workflow logic. The hierarchy, exchange rules, physical-bin relationships, and execution constraints in section 8 are requirements, not an invitation to replace them with a generic task workflow.

| Decision | Agreed direction |
| --- | --- |
| Coverage | Full replacement of current NetSuite integration capabilities, delivered in controlled phases |
| Audience and format | Combined business/developer handoff; Markdown source and matching Word document |
| Hosting design | Custom-module-capable deployment: Odoo.sh or self-hosted; exact deployment to confirm |
| MBT work definition | Odoo supplies orders, legs, jobs, dependencies, and revisions |
| MBT operational execution | Application owns dispatch assignments, execution, physical custody, and evidence |
| MBT commercial ownership | Odoo owns pricing and billing, including MBT/MBBS cross-charges |
| Other integrations | Samsara, routing/maps, photo storage, and local PWA behavior continue in the application |

MBR Contracts is currently independent of NetSuite and MBT. Adding a new MBR-to-Odoo integration is outside this replacement unless separately requested. Historical NetSuite/MBT records remain readable and auditable.

## 2. System boundaries and data ownership

One system owns each field or operation. Receiving an ERP update must not reset local preparation, driver progress, photos, or assignments.

| Information | Authoritative owner | Integration behavior |
| --- | --- | --- |
| Customers, vendors, commercial addresses, terms, tax and credit state | Odoo | Import canonical records and active/inactive changes |
| Products/variants, stock UOM, commercial UOM, ERP stock and committed quantities | Odoo | Import definitions and inventory observations; retain observation time |
| MBBS commercial orders and financial state | Odoo | App may initiate supported, authorized commands; Odoo validates and returns the authoritative result |
| Delivery instructions and requested dates | Odoo after accepted update | Preserve current app editing capability with expected-revision checks |
| Local dispatch plans, grouping/splitting, work locks, operator progress | Application | Preserve local identities and history; reference original ERP lines |
| Physical execution evidence and occurrence times | Application | Publish immutable results/corrections with stable evidence IDs |
| MBT orders, delivery/exchange/collection definitions, legs and jobs | Odoo custom module | Receive complete versioned aggregates; no local commercial creation |
| MBT truck/driver assignments, physical bin state, reservations and custody | Application | Report accepted assignment changes and actual movements to Odoo |
| MBT service prices, rental charges, dump charges, invoices and cross-charges | Odoo | Consume evidence once per business service; do not bill each execution part again |
| Operational site notes, yard routing, dump-site suitability, fleet constraints | Existing application registries by default | Odoo references mapped IDs; imports must preserve local operational fields |
| Bin/type registry | Existing application registry by default | Share stable references with Odoo; no second independently numbered physical-bin master |

Commercial address changes are proposals for future work. Issued driver instructions retain their frozen site/address snapshot until an explicit operational amendment is accepted. Odoo can request a particular bin or bin type; the application still verifies actual custody, compatibility, and availability before dispatch.

For shared operational registries, use `operational.reference.upsert` commands to publish active/inactive definitions to Odoo. Initial exports include yards, trucks, drivers, bin types/assets, dump sites, and materials used by MBT. These are operational references, not requests to create financial products or employees. The Odoo module maps them to its chosen models.

## 3. Current integration inventory and replacement requirements

The application has more integration behavior than its older overview documents describe. Current routes include order, customer, and fulfillment/receipt reconciliation webhooks, plus durable posting and webhook queues. Code is the primary source for this inventory; production feature activation was not inspected.

| Capability | Existing application behavior | Required Odoo equivalent |
| --- | --- | --- |
| Order reads and live updates | SO/PO/TO headers, lines, approvals, dates, addresses and progress | Versioned order snapshots, search, and committed events |
| Customers | Shared customer master and Returns projection; stale/conflicting updates detected | Customer/address/company identities, incremental import, inactive state and conflict handling |
| Product and inventory reads | Item definitions, PLT/LYR/SEC/PCS conversions, location stock and sales history | Variant-specific products, explicit UOM conversions, stock observations and historical demand data |
| Pickup and fulfillment | Partial pickup, location-aware posting, source-line verification, kits and durable retries | Confirm the correct outbound picking/moves once, with partial quantities and verified source lines |
| Receiving | PO/TO receipts, partial receipts, units, photos, additional PO charge verification | Inbound picking validation, remaining quantities, receipt evidence and separate charge information |
| Transfers and transit | TO creation/update/approval, source/destination stages, local CO movements and dependencies | Linked outbound/inbound movements; distinguish internal and intercompany routes |
| Smart SCM | Purchase and transfer proposals, vendor item codes, replenishment, purchasing history | Idempotent purchase/transfer commands and procurement history |
| Regular/special stock | Linked sales/purchase/transfer work, quantity/description changes, closure and recovery | Preserve supply-demand links, approvals, source revisions and uncertain-write recovery |
| Sales and Field Sales | Local quotes, confirmed sales-order creation, customer/product lookups, legacy estimate reads | Create confirmed sales work from approved app quotes; retain required quote/order references and document retrieval |
| Order maintenance | Delivery memo/dates, purchase history edits, approvals, special-order adjustments | Narrow authorized commands with optimistic concurrency and result verification |
| Returns and credits | Stock/pallet returns, return authorization and credit paths, original line/reason mappings | Physical reverse movements and financial refunds handled as distinct, correlated operations |
| Inventory damage/counts | Damage transfers and reviewable local counts | Damage/quarantine/scrap policy mapping; submit only explicitly approved stock adjustments |
| Documents and evidence | SO/PO/estimate PDFs, picking tickets, photos and attachment posting | Authenticated document retrieval and stable evidence/attachment links |
| MBT | Existing contracts, BIN work, execution, rates and local billing structures | Import Odoo-authored BIN work and export operational facts; replace prospective local commercial ownership |

Preserve per-yard/per-function posting controls. The source contains independent gates for pickup, receiving, delivery preparation, returns and credits, together with other fulfillment triggers. The migration must inventory their actual configuration and select one ERP posting owner per business completion. Do not enable all Odoo writes simply because the connection succeeds.

## 4. Architecture and delivery flow

Implement an Odoo custom bridge module and an application adapter around the existing domain services. The bridge is responsible for normalized snapshots, command validation, transaction-safe results, an outbound change log, and webhook delivery. The application adapter handles identifiers, durable inbound processing, outbound commands, and local projections.

```text
Odoo business change
    -> commit business data + version + outbound event together
    -> webhook sender with retries
    -> application durable inbox -> apply ERP-owned fields
    -> existing dispatch / operator / driver screens

Application action or MBT execution
    -> commit local result + outbound command together
    -> Odoo command inbox -> authorized business operation
    -> commit result + resulting Odoo events together
    -> application verifies outcome and reconciles its projection

Scheduled recovery
    -> read change feed -> fill gaps -> compare current snapshots
```

A webhook is a notification with a durable business snapshot; it is not proof that the application has applied it. HTTP 202 means persisted for processing. Operational completion, ERP posting, and event delivery have distinct states.

Odoo Studio offers webhook notification actions, but this specification requires additional delivery, authentication, versioning, and recovery behavior in the custom bridge. Treat those guarantees as work to implement, rather than capabilities automatically supplied by Studio. See the [Odoo automation documentation](https://www.odoo.com/documentation/19.0/applications/studio/automated_actions.html).

Use Odoo business methods for stock/accounting operations. Do not write stock balances directly or set transaction states to simulate completion. A command that requires several dependent model operations must execute as one business transaction where possible; multi-document work that cannot be atomic must expose explicit steps and recoverable outcomes.

## 5. Identity, quantities, dates and status rules

### 5.1 Stable identity

Use the tuple `(sourceInstance, companyId, entityType, entityId)` to identify an external business entity. IDs are opaque strings on the wire. `sourceInstance` identifies the configured database and environment; never derive authorization from a caller-supplied database name.

Maintain an explicit crosswalk from this tuple to the existing local ID and, where applicable, the legacy NetSuite account/model/internal ID. Never insert Odoo record IDs into `netsuite_id` columns and assume they identify the same record. Do not match customers or orders by name, email, SKU, or display number alone.

Stable line IDs are mandatory. Repeated products can exist on several order lines. An Odoo commercial line can relate to multiple stock moves and backorders. Preserve both the commercial `lineId` and operation `operationLineId`, with their UOM and location context. List position, product ID, NetSuite `orderLine`, and Odoo stock-move ID are different concepts.

BIN order, leg, job, asset and evidence IDs are independently stable. Human references such as `BIN00001X-1D` are display values, not database keys. Never change issued visit/stop IDs or immutable evidence to accommodate a new ERP ID.

### 5.2 Common value conventions

| Value | Contract |
| --- | --- |
| Quantity, conversion factor, distance, weight | Decimal string; explicit UOM; no implicit rounding or negative movement disguised as a receipt |
| Money | Decimal string plus ISO currency; Odoo owns tax and accounting rounding; no floating-point calculation in transport handling |
| Missing / null / zero | Missing required field is invalid; null means explicitly unknown/not applicable; zero is a measured or calculated zero |
| Timestamp | UTC ISO 8601 with milliseconds, such as `2026-10-22T14:00:00.000Z` |
| Business calendar date | `YYYY-MM-DD`, without conversion through midnight UTC |
| BIN business timezone | `America/Toronto`; preserve daylight-saving behavior for same-day rules |
| Revision | Positive integer encoded as a decimal string; monotonically increasing per aggregate |
| Evidence identity | Stable ID, SHA-256, MIME type, byte size, captured time, subject and authorized retrieval reference |

Keep sales, purchase and stock UOM distinct. Record the conversion used when work was issued. PLT/LYR/SEC/PCS quantities are product-specific display/handling units; an absent factor must not become 1. Odoo configuration must explicitly model any cross-category conversion, such as pieces to area. Historical evidence retains its original units and conversion snapshot.

Inventory snapshots distinguish on-hand, reserved, available and incoming quantities, plus location scope and observation time. Neither incoming stock nor a locally packed quantity is automatically free stock. Define the available-to-promise policy in Odoo and preserve its meaning in the adapter.

### 5.3 Separate status dimensions

Use separate `commercialStatus`, `executionStatus` and `financialStatus`. Normalize commercial approval/open/closed/cancelled state from the installed Odoo workflow; keep the original ERP status for diagnosis. An open order may be partially delivered and partially invoiced. A cancelled commercial request cannot erase a physical movement.

MBT `executionStatus` uses `pending`, `ready`, `assigned`, `in_progress`, `completed`, `cancelled` or `attention` for integration reporting. These are contract states mapped to existing application states. The application derives readiness from dependencies, resources and holds; an incoming `ready` hint does not bypass those checks.

## 6. API catalogue

### 6.1 Proposed custom endpoints

`ODOO_BASE_URL` and `APP_BASE_URL` are placeholders for approved HTTPS origins. All JSON uses UTF-8. IDs in URLs must be URL encoded. Endpoints are private service interfaces; browser user tokens are not accepted.

| Method and path | Host | Purpose |
| --- | --- | --- |
| `GET /api/mbbs/v1/capabilities` | Odoo | Supported schema versions, commands, entity types, limits and source instance |
| `GET /api/mbbs/v1/changes` | Odoo | Durable ordered feed for replay and reconciliation |
| `GET /api/mbbs/v1/snapshots/{entityType}/{entityId}` | Odoo | Current complete normalized aggregate and source revision |
| `GET /api/mbbs/v1/entities/{entityType}` | Odoo | Bounded search and full bootstrap enumeration |
| `GET /api/mbbs/v1/inventory` | Odoo | Product/location stock observations |
| `GET /api/mbbs/v1/sales-history` | Odoo | Paginated historical demand used by SCM |
| `GET /api/mbbs/v1/documents/{documentId}` | Odoo | Authorized PDF/attachment bytes with integrity metadata |
| `POST /api/mbbs/v1/commands` | Odoo | Durable acceptance of one idempotent business command |
| `GET /api/mbbs/v1/commands/{commandId}` | Odoo | Command state, result identities, errors and recovery state |
| `POST /api/integrations/odoo/v1/events` | Application | Durable acceptance of one signed Odoo event |
| `GET /api/integrations/odoo/v1/events/{eventId}` | Application | Restricted service lookup of application processing outcome |
| `GET /api/integrations/odoo/v1/evidence/{evidenceId}` | Application | Restricted evidence metadata or streamed bytes |

All Odoo read requests require `companyId`; entity/snapshot references cannot escape that scope. `entities` accepts `limit`, opaque `cursor`, exact `reference`, or bounded `query` for supported customer/vendor/product/order types. The initial cursor fixes filters and scope; subsequent pages cannot change them. Default page size is 100; maximum is 500. The capabilities endpoint advertises any lower environment limit.

`inventory` requires product IDs and location IDs, each limited to 100 per request, and returns per-row quantities/UOM/as-of time. `sales-history` requires `dateFrom`, `dateTo`, optional product/location filters, and cursor/limit; each request window is at most 366 days. Return stable order-line IDs, business dates, product, location, quantities, UOM, and cancellation/return indicators so SCM does not count reversed demand as a new sale.

`documents` returns `Content-Type`, `Content-Disposition`, byte length and `X-Content-SHA256`; return 202 with `Retry-After` while a requested report is being prepared. Return generation status as JSON and do not send a partial PDF. Document access is scoped to the requesting integration and company.

### 6.2 API authentication

Use a dedicated integration principal with a bearer credential for custom read/command/status endpoints. Issue separate credentials for each environment and direction. Bind each principal to an allowed source instance, companies, resource types, and commands. Enforce Odoo ACLs and business permissions inside the module; do not expose arbitrary ORM model/method execution or unrestricted `sudo`.

The bridge developer selects the version-compatible credential implementation and records it in the deployment sheet. The public contract remains `Authorization: Bearer <service-credential>`. This is a proposed custom service credential, not an assertion that every Odoo version accepts it on its native API.

### 6.3 Command envelope and lifecycle

Headers: `Authorization`, `Content-Type: application/json`, `Idempotency-Key` equal to `commandId`, and `X-Correlation-Id` equal to `correlationId`.

Required envelope fields: `schemaVersion` (`mbbs.command.v1`), UUID `commandId`, `sourceInstance`, `companyId`, `commandType`, UUID `correlationId`, `occurredAt`, `actor`, `target`, `expectedRevision` and `data`. `actor` identifies the authenticated application actor for audit; the service credential remains the authorization boundary. `target`/`expectedRevision` are null only for creation or append-only operations whose schema allows that.

The Odoo inbox persists a command before returning 202. Store its semantic request hash and business idempotency key with a unique constraint. Reusing a command ID with identical content returns its original status; different content returns 409. States are `accepted`, `running`, `succeeded`, `rejected` and `attention`. A 202 receipt is not a successful stock posting.

Scope command identity to the authenticated `(sourceInstance, companyId, commandId)`. Also deduplicate the underlying business operation: source quote/proposal ID for creation, local completion ID plus posting operation for stock work, and execution/correction event ID for MBT facts. A second command ID cannot bypass that business key. Repeated business keys return the original result when the intended operation matches, or 409 when it differs. Keep business deduplication records for the retained transaction/evidence lifetime, independently of short-term webhook replay retention.

Before mutation, check the expected source revision and permissions. Commit the business result, command outcome and emitted change events together. On an ambiguous timeout the app looks up the same command ID, then resubmits the same envelope only if needed. It must not allocate a fresh ID merely to retry. A permanent rejection requires a corrected, newly identified command referencing the rejected one in `supersedesCommandId`.

Successful results identify every affected ERP record, operation line, quantity, UOM and resulting revision. The application verifies these against its submitted operation before marking ERP posting complete. Multi-step results in `attention` identify committed steps and outstanding recovery; do not report a total rollback unless it happened.

### 6.4 Command families

| Command type | Minimum business data and controls |
| --- | --- |
| `sales_order.create` | Approved quote/proposal ID, customer, company, addresses, currency, lines, prices/discounts, delivery method and requested dates; stable source key |
| `purchase_order.create` | Approved proposal, vendor, destination, ordered lines/UOM, vendor codes, pallet lines, charges and demand links |
| `transfer.create` / `transfer.update` | Source/destination company and location, source-demand links, exact lines/UOM, intercompany intent and approval evidence |
| `order.approve` / `order.update` | Typed target, expected revision, authorized field set and approval actor; no unrestricted record patch |
| `special_order.adjust` / `special_order.close` | Linked SO/PO references, expected revisions, quantity/description/discount change or closure plan and reason |
| `fulfillment.confirm` | Source order, selected stock operation and lines, completion ID, location, physical quantity, conversion snapshot and evidence |
| `receipt.confirm` | Source PO/TO and operation lines, receiving location, completion ID, received quantities and evidence; separate receipt-charge observations |
| `return.create` / `return.receive` | Original transaction/line, reason, actual return quantities, location, pallet distinction and evidence |
| `credit.create` | Approved return/credit case, source invoice/lines, currency and reason; Odoo calculates and validates financial result |
| `inventory.damage` | Original location, damage destination/disposition, approved quantities, UOM, evidence and source observation |
| `inventory.adjust` | Explicitly approved count/reconciliation case, expected stock observation and reason; no automatic posting of blind-count drafts |
| `document.attach` | Target, stable evidence/document identity, checksum and controlled retrieval reference; no arbitrary URL fetching |
| `operational.reference.upsert` | Registry type, application ID, revision, active flag and operational attributes required by Odoo |
| `mbt.assignment.report` | Order/leg/job references, assignment revision, truck, driver, selected bin and planned time window |
| `mbt.execution.report` | Immutable job event, actual action/time, bin/custody movement, measurements and evidence |
| `mbt.execution.correct` | Original result ID, append-only correction ID, reason, actor and replacement facts |
| `mbt.exception.report` | Affected order/leg/job, observed exception, physical state and recovery requirement |
| `mbt.amendment.request` | Requested Odoo work-definition change and reason; never creates replacement jobs locally |

The capabilities response must list the exact supported command types. Unsupported types return 422, not a generic success. MBT order/leg/job creation commands from the application are excluded. Preserve existing MBBS role restrictions and per-function posting gates when exposing these commands.

## 7. Webhook events and reliable synchronization

### 7.1 Event envelope

Every event contains `schemaVersion` (`mbbs.event.v1`), UUID `eventId`, `sourceInstance`, `companyId`, `entityType`, `entityId`, `revision`, `eventType`, `occurredAt`, UUID `correlationId`, nullable `causationId`, `origin` and `data`. `origin` identifies the originating system/action for diagnosis. `causationId` is the triggering command/event ID when available.

The Odoo bridge assigns revisions inside the business transaction. Child-line/job changes increment their parent aggregate revision. Do not order changes by webhook delivery time, content-hash sort order or `write_date` alone. Independently committed changes can share a timestamp.

Each mutable aggregate event carries a full normalized snapshot, including its active children and explicit cancelled/removed child identities. A missing required child array is invalid. Omission is not permission to delete evidence. Append-only execution/correction events are never coalesced away.

| Entity type | Event types | Consumer effect |
| --- | --- | --- |
| `customer`, `vendor` | `customer.upserted`, `customer.deactivated`; corresponding vendor events | Update master/projections; retain historical references |
| `product`, `uom`, `location`, `company` | `{entityType}.upserted`, `{entityType}.deactivated` | Apply mapped definitions; incompatible changes place affected work on hold |
| `inventory` | `inventory.observed` | Update stock projection with scope, quantities, UOM and as-of time |
| `sales_order`, `purchase_order`, `transfer_order` | `{entityType}.upserted`, `{entityType}.cancelled` | Update ERP-owned headers/lines and derived availability |
| `fulfillment`, `receipt` | `{entityType}.posted`, `{entityType}.reversed` | Reconcile actual movement and source-line progress |
| `return`, `credit` | `{entityType}.updated` | Refresh separate physical/financial states and references |
| `mbt_order` | `mbt_order.upserted`, `mbt_order.cancelled` | Import complete customized BIN order/legs/jobs/dependencies |
| `mbt_billing` | `mbt_billing.updated` | Optional read-only billing outcome with service and invoice references |
| `command` | `command.completed`, `command.rejected`, `command.attention` | Inform the app of an outbound command's durable outcome |

A posting outside this application must still emit the corresponding fulfillment/receipt event. A record saved by an integration command must emit the same normalized business events as a UI save. The receiver applies those results but must not turn them into another identical outbound command.

### 7.2 Webhook authentication

Require these headers: `X-MBBS-Key-Id`, `X-MBBS-Event-Id`, `X-MBBS-Timestamp` (Unix seconds), `X-MBBS-Signature`, and `Content-Type: application/json`.

Construct the signed bytes exactly as follows, with newline separators and no trailing newline:

```text
keyId + "\n" + unixTimestamp + "\n" + eventId + "\n" + rawRequestBody
signature = "sha256=" + hex(HMAC-SHA256(secret, signedBytes))
```

Use UTF-8 and lowercase hexadecimal. Verify against the raw bytes before JSON normalization, with a constant-time signature comparison. The signed header event ID must equal the JSON event ID. Bind key IDs to the configured source instance and permitted companies. Reject unknown keys, invalid signatures, and timestamps more than 300 seconds from receiver time. Servers require clock synchronization.

On retry, keep the original event ID and body but generate a fresh transport timestamp and signature. `occurredAt` remains the original business time; legitimate delayed events can be older than five minutes. Support overlapping active/previous keys during rotation. Never put webhook secrets in the JSON body or URLs.

### 7.3 Receipt, application and conflict rules

Persist authenticated events in a durable inbox before returning 202. Deduplicate by authenticated `(sourceInstance, companyId, eventId)`. An identical duplicate is acknowledged with its existing status. The same event identity with different bytes is a 409 conflict. Events for the same aggregate are processed serially.

For mutable snapshots, lower revisions cannot overwrite higher revisions. An equal revision with identical normalized business data is unchanged; equal revision with different data is an attention conflict. A higher complete snapshot can recover a gap, but retain the gap in reconciliation tracking. Never skip append-only events solely because a newer parent snapshot arrived.

Missing master mappings or prerequisite jobs produce `waiting_dependency`, not a fabricated ID. Fetch approved missing records or wait for their feed events, then retry. Unsupported schema versions remain rejected/visible; a sender must not downgrade or drop fields silently.

Inbox states exposed by the restricted status endpoint are `accepted`, `processing`, `applied`, `unchanged`, `stale`, `waiting_dependency`, `conflict`, and `failed`. Status responses contain `eventId`, `status`, `entityType`, `entityId`, `receivedRevision`, nullable `appliedRevision`, `updatedAt`, and nullable `error` in the common error shape. A local outbox reports permanent apply failures to integration operations. Sender delivery success and receiver apply success are monitored separately.

### 7.4 Replay, bootstrap and reconciliation

`GET /changes?companyId=...&cursor=...&limit=100` returns an `events` array, `nextCursor`, `hasMore` and `highWatermark`. The cursor is opaque and scoped to the source/company/filters. It must represent a published committed order, not a bare database sequence that can advance past a still-uncommitted lower transaction. The bridge must serialize change-log publication or provide equivalent commit-safe cursor semantics.

For bootstrap, record a change-feed watermark first, enumerate all required entities with stable keyset cursors including inactive records, then replay from that watermark. Use revision guards for changes observed twice. Missing rows do not imply deletion; use explicit inactive/cancelled events. Refresh any aggregate changed during enumeration. Start with company/location/UOM/product/customer/vendor references, then MBBS transactions and MBT work.

Persist a fetched page in the inbox before advancing the recovery cursor. Retain per-event apply status independently so a blocked event does not disappear behind a later cursor. Snapshot reads must return complete committed aggregates with their revision. Use the change feed to recover events as well as to refresh current state; a latest snapshot cannot reconstruct lost append-only evidence.

Proposed defaults: retry transport failures/429/5xx after 1, 5, 30, 120 and 300 seconds, with jitter, then every five minutes; honor `Retry-After`. Alert after five minutes of failed delivery or apply lag, and escalate exhausted work to manual attention after 24 hours without deleting it. Pause automatic retries on authentication/configuration errors until corrected. Keep replayable events for at least 30 days and never prune undelivered/unresolved work. Run incremental recovery every five minutes and a nightly active-work reconciliation. These are initial operational defaults, to be load-tested and approved.

An expired cursor returns 410 `CURSOR_EXPIRED` with a restart instruction. Do not silently start at the latest event. Re-bootstrap mutable state and reconcile missing operational/financial event IDs before clearing the incident.

## 8. MBT customized BIN model and workflow

### 8.1 Terms and relationship to current code

For this external contract, **BIN order** means the rental/service-line aggregate. It contains initial Delivery, zero or more Exchanges, and final Collection. Each has one or more dispatchable **legs**; each leg contains executable **jobs** such as collect, deliver, dump or return. This vocabulary avoids confusing the existing database's `mbt_bin_orders` workflow rows with the full rental aggregate.

```text
BIN order / rental service line
  Initial Delivery
    Delivery leg -> collect empty bin, deliver bin
  Exchange 1 ... Exchange N
    Delivery leg -> optional collect empty bin, deliver replacement
    Collection leg -> collect old bin, dump, return or linked delivery
  Final Collection
    Collection leg -> collect current bin, dump, return or linked delivery
```

Odoo supplies IDs for the aggregate, service workflows, legs and jobs, together with dependencies and requested windows. The application maps them to existing service lines, visits, parts and steps. A leg, not the whole rental, is dispatched. Jobs retain stable IDs even when several actions share a human reference.

| Existing concept | Integration representation |
| --- | --- |
| Contract/service line and rental number | `mbt_order`, `commercialContractId`, `rentalReference` |
| Initial delivery, numbered exchange, final collection | `services[]` with `serviceId`, kind and exchange ordinal |
| Independently dispatchable delivery/collection part | `legs[]` with `legId` and role |
| Visit step / mandatory stop | `jobs[]` with `jobId`, `actionCode`, sequence and location |
| Cross-part prerequisite | `dependencies[]` referencing exact prerequisite/dependent job IDs |
| Physical bin and type | Mapped `assetId`, `binTypeId`, custody observation and assignment |
| Frozen driver instructions | Issued snapshot hash, order revision, leg/job IDs and assignment revision |

Existing readable references remain: `BIN00001D` for initial delivery; `BIN00001X-1` for exchange 1; `BIN00001X-1D`, `BIN00001X-1C`, `BIN00001X-1DP`, `BIN00001X-1R` for its actions; `BIN00001C`, `BIN00001C-DP`, `BIN00001-R` for final collection/dump/return. Allocate rental numbers through one authority and crosswalk existing numbers; do not renumber legacy work.

### 8.2 Required BIN aggregate data

| Level | Required business information |
| --- | --- |
| Order | Stable ID/revision/reference; company, customer, commercial contract, site and address snapshot; timezone; commercial state; services, legs, jobs and dependencies |
| Service | Stable ID; `delivery`, `exchange` or `collection`; exchange ordinal where applicable; parent billing-service identity; sequence/reuse choice for exchange |
| Leg | Stable ID and service ID; delivery/collection role; window; bin type; requested exact asset or explicit dispatch selection; source/destination; jobs; instruction state |
| Job | Stable ID; action code; order within leg; physical location/address; required evidence; material/dump constraints where applicable |
| Dependency | Exact predecessor and successor job IDs; completion requirement; same-day anchor where applicable |
| Asset reference | Mapped physical asset identity; expected custody/source observation; source may be future/planned after an identified predecessor |

`instructionState` is `draft` or `released`. Draft final collections may have unresolved scheduling/asset details and are visible as context only. Release requires complete jobs, windows, locations and resolvable asset requirements. The app must not invent missing collection jobs or silently choose a dump site to make an incomplete order dispatchable.

Use action codes from the existing logic: `collect_empty_bin`, `deliver_bin`, `pickup_bin`, `dump_bin`, `return_bin`. A bin already aboard the assigned truck or arriving through linked reuse must not acquire a duplicate physical pickup job. Odoo and the application must agree this configuration before release.

### 8.3 Rules to preserve

1. Each rental has an initial Delivery and a final Collection; Exchanges have separately schedulable delivery and collection legs.
2. Same-bin collection-first requires pickup, then dump, then delivery to the original site on the same Toronto calendar day.
3. Different-bin collection-first requires confirmed pickup before replacement delivery on the same local day. The old bin's dump and onward work can remain outstanding.
4. Delivery-first requires a different replacement bin. Old-bin pickup follows replacement delivery and may occur days later. Another exchange can exist while older collections remain pending.
5. Each collection retains its original physical bin. Final Collection concerns the current bin, while older obligations survive and prevent operational closure.
6. Collection includes pickup and dump, followed by an approved-yard return or a linked delivery of that same physical bin with the exact required type. Shared onward delivery is one physical action referenced by both workflows.
7. Cross-driver prerequisites must be durably completed before dependent execution. Reject circular reuse/dependencies and conflicting exclusive asset claims.
8. Planning checks custody, type, capacity, reservations, chronology and same-day promises. A late real-world completion is recorded and flagged; evidence is not discarded to make the plan appear compliant.
9. Truck changes require recorded custody/handoff. Changes to a linked source/destination cannot silently redirect assigned or issued work.
10. Jobs/legs are operational subdivisions of the parent service. Odoo bills the service according to its commercial rules, not once per leg, stop, retry or shared movement.

### 8.4 Amendments, cancellations and offline work

Odoo may revise unissued work. An incoming change to assigned, issued or started instructions creates an amendment conflict unless the application can accept it through an explicit unplan/recall/reissue workflow. Existing instructions and physical evidence remain intact while the change is reviewed. Odoo receives the conflict through `mbt.exception.report` and can see the event status.

Cancellation before issue may remove work from the dispatch pool. After physical execution starts, cancellation is a commercial request requiring a recovery decision; it cannot erase a bin at a customer site, a loaded truck or an outstanding dump/collection. Odoo creates any authorized recovery legs/jobs, and the application executes them.

Driver results include the issued snapshot revision/hash, device event ID, local sequence, action occurrence time and server acceptance time. Offline replay uses the original event ID. A changed Odoo order must not invalidate evidence of work performed under legitimate issued instructions. Conflicting results enter review; they are never silently reinterpreted as execution of the new jobs.

## 9. Normalized field mappings

### 9.1 Standard Odoo concepts and custom fields

The model names below are reference targets to verify against the actual deployment. They are not a claim that the customized database already contains the required fields. Standard stock models distinguish pickings, moves and detailed move lines; sales-linked moves retain their commercial line relationship. See [Odoo stock picking source](https://github.com/odoo/odoo/blob/19.0/addons/stock/models/stock_picking.py) and [sales-stock linkage source](https://github.com/odoo/odoo/blob/19.0/addons/sale_stock/models/stock.py).

| Application requirement | Odoo reference mapping | Customization / interpretation |
| --- | --- | --- |
| Customer/vendor and addresses | `res.partner` and child contacts | Preserve customer/vendor roles, address IDs and company access scope |
| Subsidiary/company | `res.company` | Explicit crosswalk; do not equate company with warehouse |
| Item and commercial units | `product.product`, `product.template`, `uom.uom` | Variant is the stock identity; preserve handling-unit conversion fields |
| Yard and stock location | `stock.warehouse`, `stock.location` | One yard can map to stock, receiving, transit, quarantine and scrap locations |
| Sales order / quote | `sale.order`, `sale.order.line` | Approval, pickup/delivery method, dates and operational notes may require custom fields |
| Purchase order | `purchase.order`, `purchase.order.line` | Preserve vendor product code, requested destination and sales-demand links |
| Fulfillment / receipt | `stock.picking`, `stock.move`, `stock.move.line` | Use operation type, direction, commercial-line link and actual completion quantities |
| Transfer order | Internal pickings/moves and routes | Multi-stage and intercompany transfer may require multiple linked documents; no universal one-to-one TO model |
| Inventory | `stock.quant` and supported stock computations | Normalize ownership/location scope and availability policy; no direct quant mutation |
| Kits | Product/BOM and component stock moves | Confirm kit/BOM module and component policy; preserve parent/component relationships |
| Returns / credits | Reverse stock operations and `account.move` refund records | Physical receipt and financial credit are separate; NetSuite RA need not map to one native Odoo object |
| Damage and count adjustments | Configured stock movement/adjustment business methods | Distinguish quarantine transfer from scrap; preserve approvals |
| Reports / attachments | Report actions and `ir.attachment` | Expose through authorized bridge endpoints and stable IDs |
| BIN order/leg/job | Custom MBT models | Technical names unconfirmed; implement the business contract in section 8 |

### 9.2 Application-specific fields that must survive

| Existing meaning | Current source examples | Normalized field |
| --- | --- | --- |
| Delivery versus customer pickup | NetSuite `custbody3` and delivery-method projection | `deliveryMethod` enum; no matching translated display labels |
| Operational delivery memo | `custbody7` | `deliveryInstructions` |
| Requested delivery date | `custbody4`, `shipDate` | `requestedDeliveryDate`, `shipDate` |
| Handling quantities | `custcol_plt`, `custcol_lyr`, `custcol_sec`, `custcol_pcs` | `handlingQuantities` with explicit factors and product context |
| Item conversion factors | `custitem_toplt`, `custitem_tolyr`, `custitem_tosec`, `custitem_topcs` | `handlingConversions` |
| Exact source line | NetSuite internal line key and REST `orderLine` | Stable `lineId` plus operation-line crosswalk |
| Line financial and closed state | `rate`, `amount`, closed flags | `unitPrice`, `lineAmount`, `closed` |
| Supply-demand relationship | Native source links plus application proposal/dependency markers | Typed `sourceReferences`, stable business operation key |
| Return reason | Source line/reason IDs, including `custcol_atlas_rc_so` | Mapped `reasonCode`; never copy numeric reason IDs across ERPs |

Current configured yard codes are `3445`, `2967`, `12441` and `150`, associated in source with NetSuite location IDs `1`, `28`, `15` and `26`. These are legacy reference values only. The deployment mapping must resolve each yard to the appropriate Odoo warehouse/company/locations; none is an Odoo ID by assumption.

### 9.3 Minimum master and order snapshots

Customer/vendor snapshots carry stable identity, display/legal name, active state, currency, terms, tax/credit status, permitted companies, and addresses/contacts with stable child IDs. Preserve local site profiles and operational contacts separately. Inactivation removes new selection eligibility but leaves history accessible.

Product snapshots carry variant identity, SKU/display name, active state, stock/sales/purchase UOM, conversion precision, handling factors, fulfillment eligibility, kit/component relationships and classification/vendor data needed by the current modules.

MBBS order snapshots carry company, customer/vendor, stable reference, source revision, separate status dimensions, source/destination locations, address snapshots, delivery method, requested dates, notes, currency, and complete source lines. Each line includes stable identity, product, description, ordered/cancelled/fulfilled/received/open quantities as applicable, UOM, location, price/amount, closed flag, supply links and operation-line references. Non-stock charge, pallet and service lines are explicitly typed; do not send them as physical stock simply because they are present on an order.

## 10. Worked payload examples

All IDs, domains, addresses and quantities in this section are synthetic. JSON examples are complete for their stated message or fragment type. Descriptive strings beginning `EXAMPLE_` are placeholders to replace, not actual credentials or measured hashes. The document builder checks that every JSON block parses.

### 10.1 Sales-order update event

This example shows one fully delivered line and one remaining line with the same product, illustrating why product ID cannot identify a transaction line. Location and master records are assumed to have been mapped first.

```json
{
  "schemaVersion": "mbbs.event.v1",
  "eventId": "10000000-0000-4000-8000-000000000001",
  "sourceInstance": "odoo-dev-example",
  "companyId": "company-mbbs",
  "entityType": "sales_order",
  "entityId": "so-4101",
  "revision": "12",
  "eventType": "sales_order.upserted",
  "occurredAt": "2026-10-22T14:00:00.000Z",
  "correlationId": "20000000-0000-4000-8000-000000000001",
  "causationId": null,
  "origin": "odoo.ui",
  "data": {
    "reference": "SO-EXAMPLE-4101",
    "customerId": "customer-201",
    "commercialStatus": "open",
    "executionStatus": "in_progress",
    "financialStatus": "not_invoiced",
    "sourceStatus": "sale",
    "deliveryMethod": "delivery",
    "shipDate": "2026-10-23",
    "requestedDeliveryDate": "2026-10-23",
    "deliveryInstructions": "Use the marked unloading area.",
    "currency": "CAD",
    "shipTo": {
      "addressId": "address-501",
      "addressLine1": "100 Example Road",
      "city": "Toronto",
      "region": "ON",
      "countryCode": "CA"
    },
    "lines": [
      {
        "lineId": "so-line-8101",
        "productId": "product-301",
        "description": "Example paving product, first allocation",
        "lineType": "stock",
        "locationId": "yard-3445-stock",
        "orderedQuantity": "10.000000",
        "fulfilledQuantity": "10.000000",
        "cancelledQuantity": "0.000000",
        "openQuantity": "0.000000",
        "uomId": "uom-piece",
        "unitPrice": "12.50",
        "lineAmount": "125.00",
        "closed": false,
        "operationLineIds": ["move-9101"],
        "sourceReferences": []
      },
      {
        "lineId": "so-line-8102",
        "productId": "product-301",
        "description": "Example paving product, second allocation",
        "lineType": "stock",
        "locationId": "yard-3445-stock",
        "orderedQuantity": "5.000000",
        "fulfilledQuantity": "0.000000",
        "cancelledQuantity": "0.000000",
        "openQuantity": "5.000000",
        "uomId": "uom-piece",
        "unitPrice": "12.50",
        "lineAmount": "62.50",
        "closed": false,
        "operationLineIds": ["move-9102"],
        "sourceReferences": []
      }
    ],
    "removedLineIds": []
  }
}
```

The application acknowledges durable webhook receipt with 202. The sender can use the restricted status endpoint to distinguish receipt from successful application:

```json
{
  "eventId": "10000000-0000-4000-8000-000000000001",
  "status": "accepted",
  "duplicate": false,
  "correlationId": "20000000-0000-4000-8000-000000000001"
}
```

### 10.2 Receipt confirmation command

The application records its receiving completion before sending this command. Odoo must verify that the referenced purchase line and operation line match, then return actual quantities and any remaining/backorder operation. Additional non-stock PO charges are returned separately, not counted as received physical stock.

```json
{
  "schemaVersion": "mbbs.command.v1",
  "commandId": "30000000-0000-4000-8000-000000000001",
  "sourceInstance": "operator-app-dev-example",
  "companyId": "company-mbbs",
  "commandType": "receipt.confirm",
  "correlationId": "20000000-0000-4000-8000-000000000002",
  "occurredAt": "2026-10-22T15:20:00.000Z",
  "actor": {"type": "operator", "id": "operator-example-7"},
  "target": {"entityType": "purchase_order", "entityId": "po-4201"},
  "expectedRevision": "8",
  "data": {
    "completionId": "receiving-completion-601",
    "operationId": "incoming-picking-7101",
    "receivingLocationId": "yard-3445-stock",
    "lines": [
      {
        "lineId": "po-line-8201",
        "operationLineId": "incoming-move-9201",
        "productId": "product-301",
        "quantity": "24.000000",
        "uomId": "uom-piece",
        "conversionSnapshot": {
          "enteredQuantity": "1.000000",
          "enteredUom": "PLT",
          "factorToTransactionUom": "24.000000"
        }
      }
    ],
    "evidenceIds": ["evidence-receipt-photo-601"]
  }
}
```

### 10.3 Durable acknowledgment and command result

Example 202 acknowledgment:

```json
{
  "commandId": "30000000-0000-4000-8000-000000000001",
  "status": "accepted",
  "duplicate": false,
  "correlationId": "20000000-0000-4000-8000-000000000002"
}
```

Later `GET /commands/{commandId}` result:

```json
{
  "commandId": "30000000-0000-4000-8000-000000000001",
  "status": "succeeded",
  "result": {
    "entityType": "receipt",
    "entityId": "receipt-7301",
    "sourceOrderId": "po-4201",
    "sourceRevision": "9",
    "operationId": "incoming-picking-7101",
    "lines": [
      {
        "lineId": "po-line-8201",
        "operationLineId": "incoming-move-9201",
        "quantity": "24.000000",
        "uomId": "uom-piece"
      }
    ],
    "remainingOperationIds": ["incoming-picking-backorder-7102"],
    "additionalCharges": []
  },
  "error": null
}
```

### 10.4 Initial BIN delivery snapshot

This is the `data` value of an `mbt_order.upserted` event. The example includes the required final Collection as draft context. It cannot be dispatched until Odoo releases a complete collection definition. Full imports also carry explicit cancelled child IDs; an empty array means none.

```json
{
  "rentalReference": "BIN00001",
  "commercialContractId": "contract-example-1",
  "customerId": "customer-201",
  "timezone": "America/Toronto",
  "commercialStatus": "open",
  "site": {
    "siteId": "site-501",
    "address": "100 Example Road, Toronto, ON, Canada"
  },
  "services": [
    {
      "serviceId": "service-1-delivery",
      "kind": "delivery",
      "reference": "BIN00001D",
      "billingServiceId": "billing-service-1-delivery"
    },
    {
      "serviceId": "service-1-collection",
      "kind": "collection",
      "reference": "BIN00001C",
      "billingServiceId": "billing-service-1-collection"
    }
  ],
  "legs": [
    {
      "legId": "leg-1-delivery",
      "serviceId": "service-1-delivery",
      "role": "delivery",
      "reference": "BIN00001D",
      "instructionState": "released",
      "binTypeId": "bin-type-20",
      "assetId": "bin-101",
      "window": {
        "startAt": "2026-10-23T12:00:00.000Z",
        "endAt": "2026-10-23T16:00:00.000Z"
      },
      "jobs": [
        {
          "jobId": "job-1-empty-pickup",
          "sequence": 1,
          "actionCode": "collect_empty_bin",
          "reference": "BIN00001D",
          "location": {
            "kind": "yard",
            "id": "yard-3445",
            "address": "200 Example Yard Road, Toronto, ON, Canada"
          },
          "evidenceRequired": ["bin_scan", "photo"]
        },
        {
          "jobId": "job-1-deliver",
          "sequence": 2,
          "actionCode": "deliver_bin",
          "reference": "BIN00001D",
          "location": {
            "kind": "customer_site",
            "id": "site-501",
            "address": "100 Example Road, Toronto, ON, Canada"
          },
          "evidenceRequired": ["bin_scan", "photo"]
        }
      ]
    },
    {
      "legId": "leg-1-final-collection",
      "serviceId": "service-1-collection",
      "role": "collection",
      "reference": "BIN00001C",
      "instructionState": "draft",
      "binTypeId": "bin-type-20",
      "assetId": null,
      "window": null,
      "jobs": []
    }
  ],
  "dependencies": [],
  "cancelledServiceIds": [],
  "cancelledLegIds": [],
  "cancelledJobIds": []
}
```

### 10.5 Exchange configuration and dependency fragments

These fragments illustrate service/dependency fields; they are not standalone order snapshots. Full events must include the referenced legs/jobs and the rest of the rental aggregate. Intra-leg sequence also enforces pickup before dump.

Same-bin collection-first: both legs refer to `bin-101`; delivery uses the bin after dumping and has no extra empty-bin pickup.

```json
{
  "serviceId": "service-1-exchange-1",
  "kind": "exchange",
  "exchangeNumber": 1,
  "reference": "BIN00001X-1",
  "sequence": "collection_first",
  "reuse": "same_bin",
  "collectionAssetId": "bin-101",
  "deliveryAssetId": "bin-101",
  "billingServiceId": "billing-service-1-exchange-1",
  "dependencies": [
    {
      "prerequisiteJobId": "job-x1-dump",
      "dependentJobId": "job-x1-deliver",
      "sameDayAsJobId": "job-x1-pickup"
    }
  ]
}
```

Different-bin delivery-first: replacement is `bin-102`, old-bin collection remains tied to `bin-101`, and there is no same-day requirement on the later pickup.

```json
{
  "serviceId": "service-1-exchange-2",
  "kind": "exchange",
  "exchangeNumber": 2,
  "reference": "BIN00001X-2",
  "sequence": "delivery_first",
  "reuse": "different_bin",
  "collectionAssetId": "bin-101",
  "deliveryAssetId": "bin-102",
  "billingServiceId": "billing-service-1-exchange-2",
  "dependencies": [
    {
      "prerequisiteJobId": "job-x2-deliver",
      "dependentJobId": "job-x2-pickup",
      "sameDayAsJobId": null
    }
  ]
}
```

Different-bin collection-first uses the pickup as prerequisite for replacement delivery and as the same-day anchor. Dump/return remain separate obligations for the old bin:

```json
{
  "sequence": "collection_first",
  "reuse": "different_bin",
  "collectionAssetId": "bin-101",
  "deliveryAssetId": "bin-102",
  "dependencies": [
    {
      "prerequisiteJobId": "job-x3-pickup",
      "dependentJobId": "job-x3-deliver",
      "sameDayAsJobId": "job-x3-pickup"
    }
  ]
}
```

### 10.6 Final collection with a linked onward delivery

This is a released collection-leg fragment. Its pickup and dump are followed by the existing delivery job on another rental. Do not create another return/delivery job for the shared destination. The full aggregate supplies the dependency below; the referenced target aggregate must already be known or fetched before dispatch.

```json
{
  "legId": "leg-1-final-collection",
  "serviceId": "service-1-collection",
  "role": "collection",
  "reference": "BIN00001C",
  "instructionState": "released",
  "assetId": "bin-102",
  "binTypeId": "bin-type-20",
  "window": {
    "startAt": "2026-10-26T12:00:00.000Z",
    "endAt": "2026-10-26T18:00:00.000Z"
  },
  "jobs": [
    {
      "jobId": "job-1-final-pickup",
      "sequence": 1,
      "actionCode": "pickup_bin",
      "reference": "BIN00001C",
      "location": {
        "kind": "customer_site",
        "id": "site-501",
        "address": "100 Example Road, Toronto, ON, Canada"
      },
      "evidenceRequired": ["bin_scan", "photo"]
    },
    {
      "jobId": "job-1-final-dump",
      "sequence": 2,
      "actionCode": "dump_bin",
      "reference": "BIN00001C-DP",
      "materialId": "material-example-1",
      "location": {
        "kind": "dump_site",
        "id": "dump-site-301",
        "address": "300 Example Dump Road, Toronto, ON, Canada"
      },
      "evidenceRequired": ["receipt", "photo"]
    }
  ],
  "linkedDestination": {
    "orderId": "bin-order-2",
    "legId": "leg-2-delivery",
    "jobId": "job-2-deliver",
    "reference": "BIN00002D"
  },
  "dependencies": [
    {
      "prerequisiteJobId": "job-1-final-dump",
      "dependentJobId": "job-2-deliver",
      "sameDayAsJobId": null
    }
  ]
}
```

If the destination is a yard, replace the link with a third `return_bin` job at the approved yard, using reference `BIN00001-R`. Final collection closure waits for its linked destination and any older outstanding collection obligations.

### 10.7 MBT execution result for Odoo billing evidence

This append-only report describes an accepted dump job. It reports measured facts and receipt evidence, not a price calculation. Its job/leg IDs must exist in the referenced issued order revision.

```json
{
  "schemaVersion": "mbbs.command.v1",
  "commandId": "30000000-0000-4000-8000-000000000002",
  "sourceInstance": "operator-app-dev-example",
  "companyId": "company-mbt",
  "commandType": "mbt.execution.report",
  "correlationId": "20000000-0000-4000-8000-000000000003",
  "occurredAt": "2026-10-26T15:40:00.000Z",
  "actor": {"type": "driver", "id": "driver-example-4"},
  "target": {"entityType": "mbt_order", "entityId": "bin-order-1"},
  "expectedRevision": null,
  "data": {
    "executionEventId": "40000000-0000-4000-8000-000000000001",
    "legId": "leg-1-final-collection",
    "jobId": "job-1-final-dump",
    "actionCode": "dump_bin",
    "billingServiceId": "billing-service-1-collection",
    "issuedOrderRevision": "9",
    "issuedSnapshotHash": "EXAMPLE_SHA256_OF_ISSUED_INSTRUCTIONS",
    "assignmentRevision": "3",
    "clientSequence": 7,
    "acceptedAt": "2026-10-26T16:05:00.000Z",
    "truckId": "truck-example-2",
    "assetId": "bin-102",
    "executionStatus": "completed",
    "measurements": {
      "netWeight": {"value": "1.250000", "uom": "tonne"},
      "distance": {
        "value": "18.400000",
        "uom": "km",
        "basis": "reviewed_odometer_difference"
      }
    },
    "receiptId": "dump-receipt-example-51",
    "evidenceIds": ["evidence-dump-photo-51", "evidence-dump-receipt-51"],
    "exceptions": []
  }
}
```

### 10.8 Exception and revision-conflict examples

Example `data` for `mbt.exception.report`; use the normal command envelope:

```json
{
  "exceptionId": "exception-example-17",
  "orderId": "bin-order-1",
  "legId": "leg-x1-delivery",
  "jobId": "job-x1-deliver",
  "code": "SAME_DAY_PROMISE_MISSED",
  "actualOccurredAt": "2026-10-24T13:10:00.000Z",
  "prerequisiteOccurredAt": "2026-10-23T15:30:00.000Z",
  "assetId": "bin-101",
  "physicalState": "at_customer",
  "recoveryRequired": false,
  "evidenceIds": ["evidence-late-delivery-17"],
  "note": "Actual delivery retained; commercial review requested."
}
```

Common 409 response shape; its inner error object is also returned in the `error` field on an asynchronously rejected command:

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "The source order changed before the requested operation.",
    "retryable": false,
    "correlationId": "20000000-0000-4000-8000-000000000002",
    "details": {"expectedRevision": "8", "actualRevision": "9"}
  }
}
```

## 11. Stock, accounting and evidence safeguards

Partial receipts and deliveries preserve outstanding demand through the configured Odoo backorder policy. Do not automatically cancel remaining quantities. Fulfillment results reference actual picking/move identities and completed quantities, including component moves for kits. The adapter must not fulfill both kit parent stock and its components for one physical operation.

For transfers, distinguish shipment from receipt and preserve the transit interval. A local CO movement does not automatically mean a new commercial transfer; document its existing inventory effect before mapping it. Intercompany work retains company-specific document identities and approvals.

Returns separate authorization, physical receipt, inspection/disposition, and credit. A credit does not prove stock returned; a received return does not authorize a financial refund. Pallet returns/charges retain their own item/reason/UOM meaning. Odoo's native business methods and configured policies determine the accounting entries.

For PO receipt charges, report the charge source line, amount, currency and financial record independently from actual received stock. Retain the existing verification behavior before the app finalizes its ERP posting status.

Photo and receipt metadata travel in JSON; large binary bodies do not. Retain current storage and access controls. Odoo retrieves approved evidence by stable ID through the evidence endpoint, or stores an authorized attachment copy with a verified checksum. An expiring URL is a transport location, not the durable evidence identity. The endpoint may stream bytes or return a short-lived authorized URL; long-lived public links are excluded.

The application is authoritative for captured evidence. Keep reported occurrence time, server receipt time, correction history and provenance separately. Phone/Samsara GPS can support operational context; it must not silently become financial distance evidence. Odoo receives the distance basis, reviewed measurements, weight units, original dump receipt and exceptions needed for billing decisions.

## 12. Errors, security and operational limits

| HTTP status | Meaning | Caller action |
| --- | --- | --- |
| 200 | Read success or known duplicate/result | Inspect business processing state |
| 202 | Durably accepted; processing pending | Track outcome by ID; do not mark ERP work complete |
| 400 | Malformed body or missing required envelope | Correct request; do not blindly retry |
| 401 / 403 | Invalid credential/signature or forbidden scope | Pause affected sender and fix configuration/authorization |
| 404 | Unknown entity, command or evidence in authorized scope | Resolve mapping or repeat same command after uncertain acceptance |
| 409 | Conflicting ID/content, source revision or issued instructions | Fetch current state; review before resubmitting |
| 410 | Replay cursor expired or deliberately retired resource | Follow explicit recovery process |
| 413 / 422 | Payload too large or unsupported/invalid business schema | Correct the payload or agree a supported versioned extension |
| 429 | Rate limited | Honor `Retry-After` |
| 500 / 502 / 503 / 504 | Temporary processing/transport failure | Retry same identity after outcome lookup where applicable |

Use HTTPS, least-privilege principals, company-scoped access and separate dev/staging/production credentials. Keep secrets in server-side configuration. Mask credentials, personal data and attachment URLs in logs; record event/command/entity IDs, revision, latency, attempt and outcome instead. Never expose native stack traces in production contract responses.

Proposed starting limits: 1 MiB JSON body, one event/command per request, 500 order lines or jobs per aggregate, four outbound requests concurrently per integration, and a 15-second HTTP request timeout. Acknowledge persisted events within two seconds under the agreed pilot load. Expose actual limits in capabilities. Larger aggregates use an explicitly introduced versioned extension; never truncate them or silently divide an atomic BIN order across unrelated events.

Webhook reception rate and worker concurrency are separate limits. Use bounded queues and leased workers with crash recovery. Prioritize operator posting and fresh operational work over full-history backfills, as the existing application does for NetSuite requests.

Monitor delivery/apply age, queue depth, retry counts, conflicts, unmapped IDs, command outcomes, reconciliation drift and credentials nearing expiry. Every failed item must have a searchable correlation ID and a controlled retry path. An unavailable Odoo service must not delete local execution or evidence already accepted from a driver.

## 13. Application implementation changes required later

This document does not implement these changes. The application team should use its existing services and queues as foundations and add an ERP adapter boundary rather than performing a broad NetSuite-name replacement.

- Add explicit provider/source identities and crosswalks while retaining existing local record IDs and legacy identifiers. Review numeric-ID assumptions in customer, order-line, posting and return code.
- Add the Odoo event inbox/command outbox, scoped service authentication, replay/reconciliation workers and operational status views. Preserve local workflow fields when applying snapshots.
- Map normalized Odoo records into existing order/customer/inventory projections and current SSE refresh behavior. Do not require a UI rewrite to switch ERP readers.
- Route enabled MBBS business writes through the Odoo bridge with stable operation IDs and post-write verification. Preserve yard/function gates and source validation.
- Add MBT aggregate import into the existing BIN planning/execution model. For migrated work, make commercial definitions read-only and route amendments to Odoo; retain app dispatch, custody and evidence controls.
- Disable prospective local MBT quoting/order placement, charge calculation and accounting submission for Odoo-owned work. Preserve historical contracts, immutable billing versions and the ability to review old work.
- Publish MBT execution/corrections once per event, with parent service references. Never let split execution parts or mirrored Odoo acknowledgments start a second billing process.

The Odoo team implements the bridge, normalized projections, business command handlers, reliable outgoing events, scoped permissions, custom BIN definitions and evidence-driven billing. Both teams own the mapping workbook, shared examples, contract acceptance tests and cutover evidence.

## 14. Migration, cutover and recovery

| Phase | Work | Exit evidence |
| --- | --- | --- |
| 1. Confirm and map | Verify version/edition/hosting; map companies, yards, products/UOM, customers, lines, BIN definitions and native/custom models | Reviewed mapping register and capabilities response |
| 2. Read-only bootstrap | Import master data and active/open business work; capture watermark and replay changes; isolate Odoo shadow projections | Counts, quantities, states and unmapped/conflicting records reconciled |
| 3. Workflow comparison | Compare source records and event behavior using synthetic/test work; exercise current MBBS and customized BIN rules | Acceptance cases pass; no live dual posting |
| 4. Controlled pilot | Select companies/yards/workflows and fresh MBT orders; activate one ERP writer for each selected operation | Operational, posting and billing-evidence outcomes verified end to end |
| 5. Production cutover | Drain/resolve old queues; record cutover watermark and writer ownership; switch readers/writers by scope | No unresolved ambiguous postings; app and ERP state reconciled |
| 6. Stabilize and retire | Monitor drift, events, retries and legacy work; disable obsolete NetSuite integration after remaining obligations finish | Support handoff, retained audit trail and agreed rollback closure |

Define cutover ownership by company, workflow and business operation, not merely a global environment toggle. Existing issued driver snapshots and in-flight NetSuite postings retain an explicit completion strategy. Reconcile an uncertain old posting before authorizing the equivalent Odoo operation. Do not replay old NetSuite fulfillment/receipt commands blindly into Odoo.

For open BIN rentals, migrate the current physical bin, outstanding old collections, released/issued jobs, custody/reservations, completed evidence and billing-service references. Odoo must not regenerate historical delivery/exchange jobs as new work. Historical invoices/deposits and opening commercial balances require an Odoo-led accounting migration; this API document does not define that separate financial conversion.

Rollback starts by stopping new affected writes and freezing the relevant queues. Reconcile every Odoo-committed operation before changing the writer back. A code rollback or old database restore does not reverse ERP stock/accounting activity. Preserve crosswalks, event/command logs and completed evidence, and use approved compensating business operations where needed.

Never run migration rehearsals or integration tests against production credentials or production data volumes. On this application host, use the repository's disposable test runner, `mbbs-tests.slice`, bounded containers and unconditional teardown. The [repository host policy](../AGENTS.md) applies, including removal of disposable containers/volumes/networks and generated test artifacts.

## 15. Acceptance scenarios

These are implementation acceptance requirements, not claims that the Odoo integration has already passed tests. Use synthetic fixtures and the installed Odoo test environment.

| ID | Scenario | Required result |
| --- | --- | --- |
| A01 | Customer/product update, then inactive update | Canonical projection changes; local site notes/history remain; inactive record cannot start new work |
| A02 | Two commercial lines use the same product | Each receipt/fulfillment targets its exact commercial and operation line |
| A03 | PLT/LYR/SEC/PCS and sales/purchase/stock UOM differ | Quantities reconcile with recorded factors; missing/invalid conversion blocks posting |
| A04 | Partial receipt or fulfillment | Only actual quantities post; remaining demand and backorder links remain correct |
| A05 | Kit order and component moves | Correct components/parent relationships; no doubled physical stock movement |
| A06 | Transfer shipped but not received | Correct transit state; destination receipt cannot be fabricated from source shipment |
| A07 | Return/pallet return and credit | Physical movement and financial credit remain separately authorized and traceable |
| A08 | Receipt has extra non-stock charges | Stock quantities stay unchanged by charges; charge source/amount are verified |
| A09 | Source quantity/location/approval changes before app posting | Expected-revision/source check blocks stale posting; operator work is retained for review |
| A10 | Duplicate event or command, including concurrent retries | One inbox/business result; same ID with different content is a conflict |
| A11 | Older/equal-conflicting revision arrives late | Older data cannot overwrite current state; equal-conflicting data enters review |
| A12 | Odoo commits a command, response is lost | Same-ID status lookup finds the original result; no second transaction |
| A13 | Webhook missing, receiver down or source restarts | Committed change log and cursor recovery restore state without losing events |
| A14 | Missing customer/asset/parent job | Work waits visibly for mapping/dependency; no invented reference or early dispatch |
| A15 | Invalid signature, stale transport timestamp, wrong company | Request rejected before apply; valid delayed event with fresh signature remains processable |
| A16 | MBT initial delivery | Odoo-defined leg/jobs enter dispatch; exact bin/source/evidence requirements are enforced |
| A17 | Same-bin collection-first exchange | Pickup then dump then delivery on same local day; no duplicate empty-bin pickup |
| A18 | Different-bin collection-first exchange | Replacement follows pickup; old bin's outstanding dump/recovery survives |
| A19 | Delivery-first and overlapping exchanges | Different replacement bin; later collections retain original asset obligations |
| A20 | Final collection with older unfinished work | Current bin is collected; rental does not close prematurely |
| A21 | Collection linked to another delivery | One physical destination job and one set of evidence; dependencies and custody preserved |
| A22 | Two dispatchers claim a bin or change trucks | Exclusive claims and recorded handoffs prevent conflicting custody |
| A23 | Odoo amends/cancels issued or started jobs | No silent instruction rewrite; review/recovery and explicit reissue where authorized |
| A24 | Offline duplicate, late, cross-device or corrected result | One movement; original occurrence and snapshot retained; corrections append, never overwrite |
| A25 | Toronto DST boundary or missed same-day promise | Business-day logic correct; late actual completion retained and flagged |
| A26 | Split legs, linked work and retried MBT evidence | Odoo receives facts once and uses parent billing service; no duplicate charge |
| A27 | Bootstrap races with updates/cancellations | Watermark replay/revisions converge; committed lower events are not skipped |
| A28 | Cutover with old queues and open BIN rentals | One posting owner; legacy identity, evidence and physical obligations preserved |
| A29 | Field Sales, SCM and special-stock commands | Correct customer/vendor, commercial prices, supply-demand links and stable proposal identity |
| A30 | PDF/evidence access and rotated credentials | Authorized retrieval/checksums work; retired credentials and other-company access fail |

Minimum release evidence includes both teams' contract results, reconciled pilot records, failure/recovery exercises, monitoring screenshots or concise audit records, and an owned cutover/rollback checklist. Passing payload syntax alone does not demonstrate operational correctness.

## 16. Odoo version and native API notes

The custom endpoints above are the integration boundary regardless of the selected Odoo release. Native APIs can be used inside an adapter or for diagnostics only after confirming the version, permissions and installed models.

Odoo introduced JSON-2 in version 19. It calls `/json/2/{model}/{method}` using bearer API keys. Models/methods vary by database; the database's `/doc` describes what is available. Each call has its own transaction, so dependent business operations should be implemented in a single appropriate method. Odoo's documentation also states commercial-plan restrictions for external API access; confirm the actual deployment entitlement. See the [official JSON-2 API documentation](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html).

Illustrative native JSON-2 request for a verified Odoo 19+ environment only; this is not one of the custom bridge endpoints:

```http
POST /json/2/res.partner/search_read
Authorization: Bearer <ODOO_NATIVE_API_KEY>
Content-Type: application/json
X-Odoo-Database: <APPROVED_DATABASE>
```

```json
{
  "domain": [["id", "=", 201]],
  "fields": ["id", "name", "active"],
  "limit": 1
}
```

Do not assume JSON-2 exists on an older release, or copy legacy XML-RPC/JSON-RPC examples into this contract without checking the target release and lifecycle. No exact deprecation date is assumed here.

Custom-module hosting is material: [Odoo Online documentation](https://www.odoo.com/documentation/19.0/administration/install/online.html) states that Online is incompatible with custom modules; [Odoo.sh documentation](https://www.odoo.com/documentation/19.0/administration/odoo_sh/getting_started/create.html) describes deploying custom modules. Confirm that the actual environment supports the bridge before implementation.

With frontend access, an administrator can usually find edition/version under Settings → General Settings → About. If that section is unavailable, the Odoo developer should supply the build/version and installed module inventory; the user does not need shell access to review this document.

## 17. Deployment confirmation register

These are environment-specific facts and approval items, not missing business decisions about MBT ownership. Do not fill them with guessed production identifiers.

| Item | Owner | Required confirmation |
| --- | --- | --- |
| Odoo release, edition and hosting | Odoo developer | Exact version/build; custom-module support; external API entitlement where used |
| Environments and endpoints | Both teams | HTTPS origins, source-instance IDs, routing and network access for dev/staging/production |
| Company and location mapping | Odoo + operations | MBBS/MBT companies, yards, warehouse/transit/damage locations and intercompany routes |
| Customer/product/UOM crosswalk | Data migration lead | Stable IDs, variants, address IDs, factors, precision and historical mappings |
| Custom BIN model mapping | Odoo developer | Technical models/fields mapped to the existing order/service/leg/job logic |
| Existing BIN references and physical state | Operations + both teams | Number allocation authority, current assets, issued jobs and unfinished obligations |
| Posting and approval matrix | Business owner + application team | Trigger/gate per workflow/yard; permitted command roles; single writer at cutover |
| Billing and evidence policy | Odoo billing owner | Parent service deduplication, accepted measurements, corrections and cross-charges |
| Authentication and rotation | Both teams | Credential implementation, company scopes, HMAC keys, rotation and expiry procedure |
| Load and recovery objectives | Operations + both teams | Peak volume, tested limits, alert routing, replay retention and recovery targets |
| Existing open transactions | Migration lead | NetSuite completion strategy, unresolved posts and source-to-Odoo identity mapping |
| Cutover and rollback ownership | Business/technical owners | Named decision makers, freeze window, reconciliations and compensating-operation process |

## 18. Source evidence and document maintenance

### 18.1 Application sources reviewed

References below are relative to this repository. They identify the current behavior that the Odoo adapter must support. The new MBT ownership in this document supersedes the earlier local commercial workflow for migrated work.

| Source | Evidence used |
| --- | --- |
| [Application routes](../server/src/server.js) | Order/customer/IF-IR webhooks, sync/admin controls, operational and commercial endpoints |
| [NetSuite adapter](../server/src/netsuite.js) | ERP read/write inventory, source fields, order and transaction operations, PDF retrieval |
| [Order webhook queue](../server/src/netsuite-order-webhook-queue-repository.js) and [policy](../server/src/netsuite-order-webhook-queue-policy.js) | Durable inbox, duplicates, revisions, retry/lease behavior |
| [Customer webhook](../server/src/netsuite-customer-webhook.js) | Canonical customer import, source identity, inactive/duplicate/conflict handling |
| [Posting adapter](../server/src/operator-netsuite-posting-netsuite-adapter.js) and [posting policy](../server/src/operator-netsuite-posting-policy.js) | IF/IR verification, kits, location and function gates |
| [Receipt charges](../server/src/operator-netsuite-receipt-charges.js) and [line identity](../server/src/netsuite-order-line.js) | Non-stock charges and exact transaction-line mapping |
| [Delivery instruction adapter](../server/src/delivery-instruction-netsuite.js) | Narrow field edits, optimistic comparison, post-write verification |
| [SCM purchase payload](../server/src/smart-scm-purchase-netsuite.js) and [transfer dependency adapter](../server/src/transfer-dependency-netsuite.js) | Procurement proposals, handling quantities and dependencies |
| [Returns adapter](../server/src/return-netsuite.js) and [damage adapter](../server/src/inventory-damage-netsuite.js) | Return/credit/physical movement separation and damage operations |
| [Field Sales runtime](../server/src/field-sales/runtime.js) and [repository](../server/src/field-sales/repository.js) | Customer/catalog reads and local quote-to-sales-order workflow |
| [BIN workflow specification](../server/test/bin-order-workflow-spec.md) | Existing references, exchange/collection rules, custody and offline acceptance criteria |
| [BIN domain](../server/src/mbt/bin-order-workflow-domain.js), [execution](../server/src/mbt/bin-order-workflow-execution.js) and [schema](../server/migrations/297_bin_order_workflows.sql) | Parts/jobs, dependencies, same-day behavior, current assets and closure obligations |
| [MBT prior design](mbt/phase-3-local-operations-shadow-billing.md) | Historical local creation/billing responsibilities superseded prospectively by the agreed Odoo ownership |
| [MBR boundary](../server/src/mbr/README.md) | Independent module excluded from NetSuite replacement |

### 18.2 Maintenance and validation

Edit this Markdown file first. Generate the Word version from the same source using the dependency-free builder:

```sh
python3 docs/tools/build_odoo_integration_doc.py
```

The builder preserves headings, tables, code examples and links, and embeds a source SHA-256 in the DOCX metadata. It checks JSON examples and local source links before generation. Its `--check` mode additionally checks the existing DOCX package and text parity without rewriting it. These are document checks, not application or live Odoo integration tests; run validation through the host's disposable bounded harness when treating it as a test workload.

Retain the Markdown and Word deliverables plus this reproducible builder. Temporary render/validation artifacts are disposable. Review native Odoo references again when the target version is confirmed, and record any business contract change as a new document version.
