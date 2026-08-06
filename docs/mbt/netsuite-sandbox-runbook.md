# MBT NetSuite Sandbox Readiness Runbook

Status: automated implementation evidence recorded; live sandbox execution,
configuration, export, and signoff are `PENDING`. Phase 2 is not operationally
complete. This runbook never authorizes a production account or a NetSuite
mutation.

## Safety boundary

- Use only an account explicitly listed in
  `MBT_NETSUITE_SANDBOX_ACCOUNT_ALLOWLIST` and whose account identifier and
  REST host are recognizably sandbox values.
- Keep `MBT_NETSUITE_WRITES_ENABLED=false` and every operational MBT database
  flag disabled before, during, and after this procedure.
- The readiness adapter performs record/metadata GET requests only. Do not
  create a probe Sales Order, Customer Deposit, file, customer, or other
  transaction.
- Do not put OAuth tokens, client secrets, passwords, card/bank information,
  or unrestricted NetSuite payloads in a mapping, note, export, screenshot, or
  evidence file.
- Internal IDs and script IDs come from the approved sandbox administrator.
  Do not copy a production identifier or infer an undocumented value.

## Implemented read-only verification boundary

The server-owned catalog chooses the strategy; an Admin cannot replace it in
mapping JSON.

| Strategy | Implemented behavior | Network effect |
|---|---|---|
| `record_by_id` | Reads one allowlisted Record REST type at `/{recordType}/{encodedInternalId}` and persists only a bounded projection. Current types are subsidiary, customer, supported sale-item variants, discount item, sales tax item, and account. | One GET with `Accept: application/json` when the check is eligible. |
| `metadata_catalog` | Reads the schema for the configured `salesOrder` or `customerDeposit` parent record and independently projects the configured custom-field script ID. | GET `/metadata-catalog/{encodedParentRecordType}` with `Accept: application/schema+json`. |
| `derived_permission` | Derives a read-permission outcome only from its server-owned representative evidence checks. | Zero requests. |
| `configured_unproven` | Records a future write permission as configuration evidence only. It cannot pass a write probe or open a write gate. | Zero requests. |
| `unsupported` | Returns `unable_to_verify`; configured data cannot manufacture proof. | Zero requests. |

The currently unsupported required checks are the Customer Sales Order form,
SOT Sales Order form, Customer Deposit form, and receipt File Cabinet folder.
Their derived form/folder permission checks therefore also cannot pass. Do not
substitute SuiteQL POST, SuiteScript, RESTlet, SOAP, or a transaction probe.
Until an official read-only proof strategy is implemented and verified, an
honest sandbox run remains `unable_to_verify` and cannot be signed off.

Independent evidence checks run with a hard concurrency ceiling of four.
Results and persisted checks still follow immutable catalog order. Metadata
schema payloads are coalesced per parent record type for the lifetime of one
read-only adapter, while each script ID is projected independently. A failed
schema request is not retained in that in-memory cache. Nothing from this
cache is written to browser Cache Storage or used as durable NetSuite proof.

The production bridge accepts only GET, rejects redirects and targets outside
the configured Record REST root, accepts only `application/json` or
`application/schema+json`, and bounds a response at 1 MiB. It uses only an
already-stored access token with more than two minutes remaining; readiness
does not invoke the legacy refresh flow. No unrestricted NetSuite response is
persisted.

## Runtime binding checklist

Set and verify these values on the designated sandbox source deployment. Do
not record secrets in this runbook or in the evidence report.

| Binding | Required condition | Observed value/status |
|---|---|---|
| `NETSUITE_ACCOUNT_ID` | Exact sandbox account identifier ending in `_SB<number>` and exactly present in the allowlist | `PENDING` |
| `NETSUITE_REST_BASE_URL` | HTTPS SuiteTalk host for that exact sandbox; normalized to `/services/rest/record/v1` | `PENDING` |
| `NETSUITE_DIRECT_ACCESS_ENABLED` | `true` on the source deployment; mirror consumers remain refused | `PENDING` |
| `MBT_NETSUITE_SANDBOX_ACCOUNT_ALLOWLIST` | Contains the exact account ID; no production account and no wildcard | `PENDING` |
| `MBT_NETSUITE_READ_TIMEOUT_MS` | Integer 1,000–60,000 ms; default 10,000 ms | `PENDING` |
| `MBT_NETSUITE_PREFLIGHT_LEASE_SECONDS` | Integer 15–900 seconds; default 120; runtime raises an undersized lease to cover bounded read waves plus safety time | `PENDING` |
| Runtime environment identity | Exactly `sandbox`; never `production` or an empty/ambiguous value | `PENDING` |
| Stored OAuth token | Existing token is unexpired by more than 120 seconds; never copy its value into evidence | `PENDING` |

The configured account ID and separately observed runtime account identity
must be exactly equal. The adapter requires the corresponding
`-sb<number>.suitetalk.api.netsuite.com` host, HTTPS, no credentials in the
URL, and no port, query, or fragment. A binding mismatch fails before an
outbound request.

Runtime fingerprint schema v3 binds the configured account ID, separately
observed runtime account ID, runtime environment, normalized Record REST root,
direct-access state, exact allowlist membership, read timeout, and effective
preflight lease. A change to any of them makes prior evidence stale and blocks
signoff until a fresh run completes. When the application reloads a replacement
environment file, NetSuite values owned by the previous file but omitted from
the replacement are restored to their original ambient value or removed; they
must not survive as stale readiness configuration. Unrelated process values
are preserved.

## Semantic mapping configuration

The mapping editor accepts one JSON object only. Its top-level keys are limited
to `expected` and `caseInsensitiveFields`; the server catalog's expectations
always override conflicting Admin values.

- The serialized configuration is limited to 32 KiB, 256 nodes, and depth 8.
- Expected values are bounded strings (at most 1,024 characters), booleans,
  finite numbers, or arrays containing at most 100 of those scalar values.
- Supported evidence fields are limited to operational identity, active state,
  subsidiary/currency/terms/tax relationships, account/customer/field type,
  applicability, folder path, record type, script ID, permission level, and
  approved display identity fields.
- Credential-like keys and secret/token/authorization text are rejected.
- `caseInsensitiveFields` must be a unique array of supported field names, and
  each named field must exist in configured or server-owned expected evidence.
- The server catalog constrains every remote record type. Metadata mappings
  additionally require a safe script ID. Mapping saves require the current
  revision, a unique idempotency key, and a meaningful audit reason.

### Official Record REST evidence shapes

- Subsidiary evidence uses Oracle's lowercase `legalname` and `isinactive`
  properties plus the `currency` reference. The preflight persists only the
  bounded legal-name, active-state, and base-currency projection.
- Account evidence uses `acctName`, the exact `acctType.id` (never its display
  label), and `subsidiary.items`. Revenue accounts allow exact types `Income`
  or `OthIncome`; deposit liability accounts allow only the server-owned
  liability type list.
- Sale items use the exact allowlisted Record REST IDs `servicesaleitem`,
  `noninventorySaleItem`, or `otherChargeSaleItem`; discounts use
  `discountItem`. The logical `sales_order_item` name is never sent as a remote
  record type.
- Customer, sale-item, and account records must show membership in the current
  MBT subsidiary. Customer and sale-item mappings also require a dedicated
  subsidiary input exactly equal to the current MBT subsidiary mapping and
  cannot be saved before that mapping exists. Account mappings prove
  membership from the record and intentionally expose no separate editable
  subsidiary input.
- Customer `terms` and `taxItem` are nullable evidence. An explicitly observed
  JSON `null` may satisfy an approved null expectation; an absent property or
  unusable reference is missing evidence and cannot masquerade as null.

## Account and identity signoff

Complete this table outside source control when a value is sensitive. The
checked-in Phase 2 evidence records only the approved sandbox account ID,
configuration hash, run UUID, actor, time, note, and sanitized report path.

| Check | Expected | Observed sandbox value | Status | Verified by/date |
|---|---|---|---|---|
| Account ID | Exact allowlisted sandbox account | `PENDING` | `PENDING` | `PENDING` |
| REST URL | HTTPS NetSuite SuiteTalk sandbox host | `PENDING` | `PENDING` | `PENDING` |
| MBT subsidiary | Active; approved legal name/internal ID/base currency | `PENDING` | `PENDING` | `PENDING` |
| Intercompany customer | Internal ID 33; exact approved identity; active; correct currency, terms, tax/credit state, and MBT relationship | `PENDING` | `PENDING` | `PENDING` |
| Customer Sales Order form | Required but currently `unsupported`/`unable_to_verify` | `PENDING` | `PENDING` | `PENDING` |
| SOT cross-charge Sales Order form | Required but currently `unsupported`/`unable_to_verify` | `PENDING` | `PENDING` | `PENDING` |
| Customer Deposit form | Required but currently `unsupported`/`unable_to_verify` | `PENDING` | `PENDING` | `PENDING` |
| Tax strategy | Approved readable tax mapping | `PENDING` | `PENDING` | `PENDING` |
| Revenue accounts | Transport, dump, and rental mappings readable and correct | `PENDING` | `PENDING` | `PENDING` |
| Deposit account | Liability account; not revenue | `PENDING` | `PENDING` | `PENDING` |
| Receipt folder | Required but currently `unsupported`/`unable_to_verify` | `PENDING` | `PENDING` | `PENDING` |

## Item mappings

| Logical key | Expected purpose | Internal/script ID | Active and MBT-available | Status |
|---|---|---|---|---|
| `initial_service` | Initial delivery/service | `PENDING` | `PENDING` | `PENDING` |
| `rental` | Rental | `PENDING` | `PENDING` | `PENDING` |
| `extension` | Extension | `PENDING` | `PENDING` | `PENDING` |
| `exchange` | Exchange | `PENDING` | `PENDING` | `PENDING` |
| `pickup` | Pickup/return | `PENDING` | `PENDING` | `PENDING` |
| `dump` | Customer dump tariff | `PENDING` | `PENDING` | `PENDING` |
| `downtown_surcharge` | Downtown surcharge | `PENDING` | `PENDING` | `PENDING` |
| `discount` | Approved discount | `PENDING` | `PENDING` | `PENDING` |
| `cross_charge` | MBBS SOT cross-charge | `PENDING` | `PENDING` | `PENDING` |

## Transaction custom fields

| Logical key | Compatible field type/applicability | Script ID | Status |
|---|---|---|---|
| `local_contract_uuid` | Contract UUID | `PENDING` | `PENDING` |
| `contract_sequence` | Positive contract document sequence | `PENDING` | `PENDING` |
| `predecessor_sales_order` | Predecessor NetSuite Sales Order | `PENDING` | `PENDING` |
| `billing_version_id` | Immutable local billing-version UUID | `PENDING` | `PENDING` |
| `billing_line_uuid` | Immutable local billing-line UUID | `PENDING` | `PENDING` |
| `external_idempotency_key` | External create/reconciliation identity | `PENDING` | `PENDING` |
| `physical_load` | Physical load reference | `PENDING` | `PENDING` |
| `plan_date` | Dispatch plan date | `PENDING` | `PENDING` |
| `truck` | Truck reference | `PENDING` | `PENDING` |
| `driver` | Driver reference | `PENDING` | `PENDING` |
| `source_references` | Root SO/TO/PO/VRMA references | `PENDING` | `PENDING` |
| `raw_distance_metres` | Unrounded provider metres | `PENDING` | `PENDING` |
| `display_distance_kilometres` | Display kilometres | `PENDING` | `PENDING` |
| `rate_band_reference` | Locked rate-band/version reference | `PENDING` | `PENDING` |
| `downtown_surcharge` | Applied surcharge evidence | `PENDING` | `PENDING` |
| `allocation_evidence` | Deterministic cross-charge allocation evidence | `PENDING` | `PENDING` |

## Integration permission review

| Logical key | Read-only Phase 2 proof | Status |
|---|---|---|
| `read_subsidiary` | Designated role can read subsidiary metadata | `PENDING` |
| `read_customer` | Designated role can read customer 33 metadata | `PENDING` |
| `read_forms` | Currently derived from unsupported form proof and therefore `unable_to_verify` | `PENDING` |
| `read_items` | Designated role can read mapped items | `PENDING` |
| `read_accounts_tax` | Designated role can read accounts and tax metadata | `PENDING` |
| `read_custom_fields` | Designated role can read field metadata | `PENDING` |
| `read_file_cabinet_folder` | Currently derived from unsupported folder proof and therefore `unable_to_verify` | `PENDING` |
| `future_sales_order_write` | Configured for a later phase; mark only `configured_unproven` | `PENDING` |
| `future_customer_deposit_write` | Configured for a later phase; mark only `configured_unproven` | `PENDING` |
| `future_file_cabinet_write` | Configured for a later phase; mark only `configured_unproven` | `PENDING` |

Future permissions are never tested by writing in Phase 2. A configured value
does not enable the application write gate.

## Application procedure

1. Verify the two environment write gates and all operational database flags
   are closed.
2. Log in as Admin and open `/mbt/config`, then select **NetSuite Readiness**.
3. Enter each sandbox mapping from the approved NetSuite administrator. Every
   save requires the displayed revision, a unique idempotency key generated by
   the UI, and a meaningful audit reason.
4. Confirm every real ID, record type, script ID, and semantic expectation
   against the approved sandbox administrator record. Start one read-only
   preflight only after the runtime binding checklist is complete.
5. Review every failed or unable-to-verify check. Missing permission is a
   failure; do not add a SuiteScript or transaction probe to bypass it.
6. Export both JSON and CSV. Verify the account ID, configuration hash, run
   UUID, ordered check count, and absence of secrets/raw payloads.
7. Do not sign off while any required form or File Cabinet proof remains
   `unsupported`/`unable_to_verify`. After an approved official read strategy
   is implemented and a current run genuinely passes, enter an Admin audit
   note and sign it off.
8. Change nothing after signoff. Any mapping revision invalidates the pass and
   signoff and requires a fresh run.
9. Record the sanitized evidence below and in `docs/mbt/evidence/P2.md`.

## Final sandbox evidence record

| Evidence | Value |
|---|---|
| Approved sandbox account ID | `PENDING` |
| Configuration hash | `PENDING` |
| Preflight run UUID | `PENDING` |
| Run completion time | `PENDING` |
| Admin actor | `PENDING` |
| Signoff time | `PENDING` |
| Signoff note | `PENDING` |
| Sanitized JSON report path/hash | `PENDING` |
| Sanitized CSV report path/hash | `PENDING` |
| Probe transaction count | Must remain zero; observation `PENDING` |
| NetSuite write gate | Must remain false; observation `PENDING` |
| Operational MBT flags | Must all remain false; observation `PENDING` |

The final automated P2 gauntlet passed on 2026-08-03. Phase 2 is nevertheless
not operationally complete while any live-sandbox value in the final evidence
record is `PENDING` or while required proof remains `unsupported`.
