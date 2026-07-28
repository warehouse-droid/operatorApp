# Smart SCM

Smart SCM is isolated from the existing Sales Order Auto Transfer flow. Its tables use the `scm_smart_*` prefix, its staff APIs use `/api/scm/smart/*`, and its pages are:

- `/scm/smart` — live Item Master, raw sales CSV upload, forecast evidence, PO/TO proposal review, vendor replies, and settings.
- `/scm/printers` — four yard printer queues, agent tokens, health, tests, and retries.

## Safety defaults

- Migration 039 seeds `execution_mode=mock` and `forecast_mode=shadow`.
- A user must explicitly confirm each TO proposal.
- Live TO creation requires both the database mode `live` and `SMART_SCM_LIVE_EXECUTION_ENABLED=true`.
- A source yard must have an enabled printer name and agent token before TO confirmation.
- Once any NetSuite or mock execution reference exists, the proposal cannot be released or executed again. Picking-ticket recovery reuses that reference and the same idempotent print-job key.
- Confirmed/executing/completed TOs are immutable during vendor replanning. Their item coverage is subtracted before a replacement is suggested.

## Data sources

- Item identity, descriptions, conversion factors, vendor, and live inventory come from NetSuite. Planning refreshes inventory but does not request NetSuite sales history.
- Lead time, vendor yard, planning eligibility, capacity, service level, and the optional per-yard lower-stock policy are maintained in the spreadsheet-style Item Master. Its CSV template supports the same bulk policy updates.
- Sales history is supplied through **Forecast > Raw sales data CSV**. Uploading a valid file atomically replaces the previous CSV/NetSuite Smart SCM sales facts; a failed validation leaves the current dataset unchanged.
- CSV columns `Internal ID`, `Date`, `Quantity`, and `Location` are required. `Document Number`, `Item`, `Delivery Method`, `Sales Amount`, and `Status` are optional. Quantity may be positive or use NetSuite's negative sales convention. Location accepts yard codes `3445`, `2967`, `12441`, and `150`, their local location IDs, or a location name containing the yard code. Cancelled and invalid rows are reported as rejected.
- The upload records filename, SHA-256 checksum, row count, item count, and date coverage in sync status and the audit log. Raw source files are not retained as versioned inputs.

Legacy seeded workbook facts remain a fallback until the first raw sales CSV is uploaded. Once any CSV sales facts exist, forecasts use the CSV dataset exclusively.

## Planning model

The formula policy calculates inventory position from current NetSuite balances and open supply/demand, then calculates seasonal lead-time demand, safety stock, reorder point, preferred stock, capacity, and minimum order in pallets. Formula, moving-average, Croston SBA, TSB, and hierarchical candidates run in parallel as explainable forecast evidence. Prediction stays shadow-only unless history, backtest WAPE, bias, and explicit yard/series promotion gates all pass.

The **Lower stock policy** checkbox is independent for every item and yard and defaults off. When selected, planning uses a 1-PLT minimum safety floor while retaining the current demand variability, lead time, service factor, coverage floor, and capacity rules. Safety stock, ROP, and preferred stock are then recalculated normally. Forecast evidence and proposal snapshots show both the standard and lowered values when the policy changes a result; if variability or another active floor already controls the result, the enabled policy is shown as having no level change.

Transaction-compatible lines are capacity-packed only when type, phase, source, destination, vendor, urgency, and provisional state match. Cross-destination multi-stop loads remain a dispatch-planning concern because one NetSuite Transfer Order can only have one destination.

Vendor replies support confirmed, partial, out of stock, production ETA, credit hold, and cancelled states. Each reply creates a plan revision. Unaffected lines remain in their draft load; only the changed item is removed/recalculated.

## Yard printer agent

1. Install the required printer and SumatraPDF on the Windows yard PC.
2. Enter the exact value returned by `Get-Printer` on `/scm/printers`. If the queue needs a specific tray, enter that driver queue's Windows `RawKind` input-bin value; leave it blank to use the queue default.
3. Generate a token. It is displayed once.
4. Download `Install-MBBSYardPrinterAgent.ps1` from the page and run the generated command in an elevated PowerShell window.
5. Queue a test page and verify the agent becomes online.

To upgrade an existing v2 PC, download the v3 script and run it once with no parameters in an elevated PowerShell window. It reuses `C:\ProgramData\MBBS\YardPrinterAgent\agent.json`, so no token rotation is required.

The agent is restricted to one yard by its hashed token and agent ID. Agent v3 sends explicit SumatraPDF `bin=<RawKind>` settings, reports receive/download/hash/per-printer process timings and errors, and renews the lease while a long Sumatra process is still running. Jobs use SHA-256 document verification. A disconnect after printing starts becomes `uncertain` and requires a human check before requeue.

## NetSuite RESTlet (sandbox first)

`netsuite-smart-scm-picking-ticket-restlet.js` is a SuiteScript 2.1 RESTlet with
two authenticated, read-only actions:

- `health`: reports the NetSuite account/environment, deployed script identity,
  role/user IDs, remaining governance, and supported capabilities.
- `pickingTicket`: renders the same picking-ticket PDF used by Smart SCM and
  Sales Printing. `includeContent=false` tests rendering without transferring
  the base64 document.

Supplying `entityId` without an action remains compatible with the original
RESTlet. Both GET and POST are supported. Invalid requests throw named
SuiteScript errors instead of returning an `ok: false` body with HTTP 200.

### Sandbox deployment

1. Sign in to the NetSuite sandbox and upload
   `netsuite-smart-scm-picking-ticket-restlet.js` to the File Cabinet.
2. Create or update a RESTlet script record for that file. Create a sandbox
   deployment with status **Testing** while validating it.
3. Keep **Available Without Login** disabled. Limit the deployment audience to
   the OAuth integration role, and ensure that role can view and print the test
   transactions it needs.
4. Copy the deployment's **External URL**. Use the account-specific RESTlet URL
   NetSuite supplies instead of manually constructing a data-center hostname.
5. Put that URL in the active sandbox environment:

```env
SMART_SCM_PICKING_TICKET_RESTLET_URL=https://ACCOUNT.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=...&deploy=...
```

The same environment must contain the sandbox account ID, sandbox OAuth client,
sandbox REST/SuiteQL URLs, and the exact localhost callback registered on that
integration. Complete OAuth login before running the live check.

### Test contract locally

```sh
npm run test:netsuite-restlet
```

The harness stubs NetSuite modules and verifies the health response, legacy GET
compatibility, POST rendering, location/form/ship-group options, metadata-only
mode, sandbox enforcement, stable validation errors, and sanitized unexpected
errors.

### Test the deployed sandbox RESTlet

From the rebuilt port-3099 app container:

```sh
docker compose -f docker-compose.yml -f docker-compose.v2.yml exec app npm run test:netsuite-restlet-live
```

To validate that a real sandbox transaction can render without downloading its
PDF, add its internal ID and optional NetSuite location internal ID:

```sh
docker compose -f docker-compose.yml -f docker-compose.v2.yml exec app npm run test:netsuite-restlet-live -- --entity-id=12345 --location=28
```

The live checker requires the RESTlet itself to report `sandbox: true`. It will
refuse a production deployment unless `--allow-production` is deliberately
provided.

Live Smart SCM execution creates the TO without `orderStatus`, patches it to
Pending Fulfillment, hydrates the local inbound/outbound order mirror, retrieves
the exact NetSuite picking-ticket PDF, and queues it to the source yard.

## Verification

```sh
npm run test:smart-scm
```

The harness uses active real input data inside a rollback transaction. It verifies forecasts, capacity-packed plans, vendor revision behavior, all four printer rows, agent authentication, job leasing, document hash integrity, and the printed callback without leaving test records.
