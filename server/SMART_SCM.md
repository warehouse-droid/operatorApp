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
- Lead time, vendor yard, planning eligibility, capacity, service level, and minimum safety stock are maintained in the spreadsheet-style Item Master tab.
- Sales history is supplied through **Forecast > Raw sales data CSV**. Uploading a valid file atomically replaces the previous CSV/NetSuite Smart SCM sales facts; a failed validation leaves the current dataset unchanged.
- CSV columns `Internal ID`, `Date`, `Quantity`, and `Location` are required. `Document Number`, `Item`, `Delivery Method`, `Sales Amount`, and `Status` are optional. Quantity may be positive or use NetSuite's negative sales convention. Location accepts yard codes `3445`, `2967`, `12441`, and `150`, their local location IDs, or a location name containing the yard code. Cancelled and invalid rows are reported as rejected.
- The upload records filename, SHA-256 checksum, row count, item count, and date coverage in sync status and the audit log. Raw source files are not retained as versioned inputs.

Legacy seeded workbook facts remain a fallback until the first raw sales CSV is uploaded. Once any CSV sales facts exist, forecasts use the CSV dataset exclusively.

## Planning model

The formula policy calculates inventory position from current NetSuite balances and open supply/demand, then calculates seasonal lead-time demand, safety stock, reorder point, preferred stock, capacity, and minimum order in pallets. Formula, moving-average, Croston SBA, TSB, and hierarchical candidates run in parallel as explainable forecast evidence. Prediction stays shadow-only unless history, backtest WAPE, bias, and explicit yard/series promotion gates all pass.

Transaction-compatible lines are capacity-packed only when type, phase, source, destination, vendor, urgency, and provisional state match. Cross-destination multi-stop loads remain a dispatch-planning concern because one NetSuite Transfer Order can only have one destination.

Vendor replies support confirmed, partial, out of stock, production ETA, credit hold, and cancelled states. Each reply creates a plan revision. Unaffected lines remain in their draft load; only the changed item is removed/recalculated.

## Yard printer agent

1. Install the required printer and SumatraPDF on the Windows yard PC.
2. Enter the exact value returned by `Get-Printer` on `/scm/printers`, enable the queue, and save.
3. Generate a token. It is displayed once.
4. Download `Install-MBBSYardPrinterAgent.ps1` from the page and run the generated command in an elevated PowerShell window.
5. Queue a test page and verify the agent becomes online.

The agent is restricted to one yard by its hashed token and agent ID. Jobs use expiring leases and SHA-256 document verification. A lease that expires after printing starts becomes `uncertain` and requires a human check before requeue.

## NetSuite picking ticket

Deploy `netsuite-smart-scm-picking-ticket-restlet.js` as a NetSuite RESTlet for the same integration role, then configure its external URL:

```env
SMART_SCM_PICKING_TICKET_RESTLET_URL=https://ACCOUNT.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=...&deploy=...
```

Live execution creates the TO without `orderStatus`, patches it to Pending Fulfillment, hydrates the local inbound/outbound order mirror, retrieves the exact NetSuite picking-ticket PDF, and queues it to the source yard.

## Verification

```sh
npm run test:smart-scm
```

The harness uses active real input data inside a rollback transaction. It verifies forecasts, capacity-packed plans, vendor revision behavior, all four printer rows, agent authentication, job leasing, document hash integrity, and the printed callback without leaving test records.
