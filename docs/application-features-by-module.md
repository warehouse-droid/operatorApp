# MBBS Operation Application Features By Module

Last reviewed from repo code: 2026-07-07

This document describes the current application features by module. It is based on the routes, frontend files, backend APIs, repositories, and migrations in this repository.

## Application Overview

The application is a local Node.js and PostgreSQL operations system for MBBS yard, dispatch, driver, and control workflows. It connects to NetSuite for SO, PO, TO, item, inventory, and order status data; Samsara for truck/driver status, DVIR, and vehicle locations; Google Maps for dispatch routing; and Cloudflare R2 for photo storage and preview.

Main user-facing routes:

- `/` - route menu for the main application areas.
- `/operator` - tablet PWA for yard operators.
- `/driver` - phone PWA for drivers.
- `/dispatch` - dispatch menu.
- `/dispatch/planning` - desktop dispatch planning.
- `/dispatch/setup` - dispatch setup and audit tools.
- `/dispatch/monitor` - Samsara truck monitor map.
- `/dispatch/statistics` - dispatch performance statistics.
- `/dispatch/dvir` - DVIR photo review.
- `/control` - admin/control panel.
- `/delivery` - legacy route that redirects to `/operator`.

Shared platform features:

- Role based login for operator, dispatcher, and admin accounts.
- 24 hour driver PWA login session.
- Bilingual UI support for English and Simplified Chinese UI labels.
- Operator and driver PWAs with service worker caching and install manifests.
- Server-sent events for live app updates across operator, driver, dispatch, and control screens.
- Photo upload tokens for PWA uploads to Cloudflare R2.
- R2-backed image preview through the server.
- PostgreSQL audit logging for operator actions, dispatch actions, sync, warnings, and record updates.
- NetSuite OAuth connection and environment switching for production/sandbox env files.
- Manual and automatic NetSuite sync controls.
- NetSuite webhook endpoint for SO, PO, and TO updates.
- Google Maps route previews and travel-time estimation.
- Samsara API integration for driver duty, truck monitor, DVIR, and vehicle assignment.

## Operator PWA

Route: `/operator`

Primary files:

- `server/public/operator.html`
- `server/public/operator.js`
- `server/public/operator.css`
- backend APIs under `/api/delivery`, `/api/receiving`, `/api/customer-pickup`, `/api/inventory`, `/api/cycle-count`, `/api/operator`

The operator PWA is designed for tablet use in the yard. It starts with operator login and a yard/location selection. The current location is shown in the top bar and can be changed from the top bar dropdown. The app keeps the last active module and selected context in local storage so refresh does not always return to the main menu.

Operator menu modules:

- Customer Pickup
- Receiving
- Cycle Count
- Delivery Prep
- Return
- Personal History

Shared operator UI behavior:

- Large touch-oriented controls for tablet use.
- Normal and compact line-list modes. Normal shows fewer cards with descriptions; compact shows more lines and hides descriptions.
- Pagination instead of relying on long scrolling for order and line lists.
- Quantity steppers for PLT, LYR, SEC, PCS, or sales UOM fallback.
- Camera capture with front/back camera switching.
- Photo proof upload to R2.
- Operator lock/release logic for orders being prepared.
- Top-bar release button to release the current order lock and clear only the current draft/confirmed lines.
- Live notifications for urgent delivery-prep work, including browser/PWA notification and custom ding sound.

### Customer Pickup

Customer Pickup handles pickup Sales Orders only. It distinguishes pickup orders by NetSuite delivery method wording such as `Pick-Up`.

Features:

- Zebra scanner-ready manual input field.
- Camera QR/barcode scanner support for QR-capable browsers.
- Manual order number entry.
- Exact customer pickup lookup by order number and current yard location.
- Prevents delivery orders from appearing in customer pickup.
- Shows completed pickup orders with a precise notice instead of allowing further loading.
- Reuses the delivery-style order line screen for picking/loading.
- Confirm line flow records draft loaded quantities.
- Load flow requires photo proof.
- Allows partial pickup. Remaining quantity stays open in local DB for the next pickup visit.
- Stores loaded quantity in sales quantity and sales UOM, matching NetSuite quantity concepts.
- Removes the whole-order unpack button from pickup flow.

### Delivery Prep

Delivery Prep is used to prepare Sales Orders, Transfer Orders, local CO transit orders, split orders, and grouped orders for drivers.

Entry choices:

- Batch view
- Saved Orders
- Per Load View

Batch view includes:

- Planned
- Batch A
- Batch B
- TO

Batch definitions:

- Planned: orders already planned by dispatch, regardless of delivery time.
- Batch A: today delivery orders and tomorrow-before-noon delivery orders when not yet dispatch planned.
- Batch B: later delivery orders or orders without delivery date.
- TO: transfer orders for outbound preparation.

Delivery Prep features:

- Active and Packed lists.
- Planned order sorting by planned date and load sequence.
- Batch sorting by expected delivery date and delivery time.
- Star button to save/unsave orders from any order card.
- Saved Orders pool for cross-order preparation.
- Confirm line and Confirm Page actions.
- Confirmed line indication before packing.
- Packing button is blocked if there are no confirmed lines.
- Preparing lock prevents leaving an in-progress order unless released by the same operator.
- Lock is per account, not global for every operator.
- Packed, underpack, loaded, and warning states.
- Underpack means partially packed or partially loaded with remaining open quantity.
- Packed view shows only packed-but-not-loaded lines, not already loaded lines.
- Unpack line affects only the selected line.
- Unpack whole order is available only where appropriate, not in customer pickup.
- Final load check prevents loading if packed quantity exceeds latest required quantity or if NetSuite removed a line.
- If NetSuite changes after packing, operator sees warning instructions to unpack/repack the affected line.
- Full note/memo display support for delivery prep orders.
- Expected delivery date display standardized as `DD-MMM`.
- Grouped orders appear in operator screen as source order references joined by `+`; quantities are summed.
- Grouped order load photo can be uploaded once and related source orders point to the same packed/loaded record.
- CO source-yard flow: CO appears in source yard active Delivery Prep first, then can be packed/loaded.
- CO destination-yard flow: after source load, the CO appears in destination Receiving. After receiving, the related source order becomes packed at the destination yard and ready to load.

Delivery Prep integrations:

- Dispatch planning flags and parking/load messages.
- Dispatch unpack requests shown to operator.
- Urgent notification for new Batch A or planned work in the current yard.
- Local yard order status stored in DB. Delivery prep no longer directly posts Item Fulfillment to NetSuite for loading.

### Receiving

Receiving handles Purchase Orders, Transfer Orders, and local CO transit orders.

Features:

- Choose receiving type: Purchase Order, Transfer Order, or Transit CO.
- Sticky search for PO/TO number.
- Product search with autocomplete and PO/TO filtering.
- Purchase Orders grouped by vendor.
- Transfer Orders grouped by source location, excluding the operator current yard as a source choice.
- CO receiving from local transit depot flow.
- Number pad for order search.
- Order list and item line pagination.
- Confirm line for received quantities.
- Receive screen requires photos before receipt completion.
- PO receiving uses vendor/source details and receivable remaining quantities.
- TO receiving uses source and destination yards.
- CO receiving updates the related SO/TO transit flow.
- Quantity display uses PLT/LYR/SEC/PCS only when conversion fields exist. If all conversion fields are empty, it shows sales/purchase quantity and UOM.
- Receive logic converts operator unit quantities into NetSuite quantity/UOM where applicable.
- Receiving records are viewable later through history/control modules.

### Cycle Count

Cycle Count is for blind inventory counting.

Workflow:

- Select product type.
- Select brand.
- Select series.
- Select SKU.
- Search bar available through the module.

Features:

- Product type/brand/series comes from local item classifications.
- Local item classifications are editable in Control Panel.
- SKU cards are paginated.
- Selected SKU panel has number pad style quantity input.
- Counts can be entered by PLT, LYR, SEC, PCS when conversion exists.
- If no conversion exists, the system shows and counts in default sales UOM.
- On-hand and available quantity can be hidden from the operator for blind count, but they are recorded with the count.
- Confirm line stores lines in a temporary draft.
- Submit creates a cycle count record for Control Panel review.
- Submitted cycle count records are not editable from the operator side.

### Return

The Return menu currently exposes:

- Pallet Return
- Stock Return

The UI entry exists in the operator menu. Earlier prototypes included customer autocomplete, SO scanner/manual input, pallet quantity entry, and product return by order. The current production code should be reviewed before relying on these flows operationally.

### Personal History

Personal History lets an operator review their own submitted work.

Features:

- Date filter.
- Shows operational records only, such as confirm line, load/IF-style records, receipt/IR-style records, cycle counts, and return records.
- Excludes sync/system update noise.
- Record detail view includes item name, description, visible units, sales quantity, and photos.
- R2 photo previews work even if the operator changes device.
- Photo lightbox for full image preview.
- Operator can report an error on a record.
- Reported errors create Control Panel warnings for supervisor review.

## Driver PWA

Route: `/driver`

Primary files:

- `server/public/driver.html`
- `server/public/driver.js`
- `server/public/driver.css`
- `server/src/driver-repository.js`
- backend APIs under `/api/driver`

The driver PWA is designed for phone use. It shows only the next assigned job from confirmed dispatch plans.

Features:

- Driver login from Dispatch Setup driver accounts.
- Shows plan date, driver name, and truck plate in a compact top row.
- Reads jobs from confirmed dispatch plans.
- Each stop is treated as a driver job.
- Travel stops, pickup stops, drop-off stops, and return-load travel are supported.
- Job screen shows stop type, destination/address, Maps button, order items, and required quantities.
- Item list is paginated for phone layout.
- Item row shows quantity/unit on the right and one-line description.
- Maps button opens phone navigation to the stop destination.
- Start button required for every job. Starting changes stop status to in progress.
- Completion is blocked for 10 seconds after start to prevent accidental double taps.
- Samsara GPS location check verifies the truck is near the expected stop before completion.
- Location override is available when location check warns/unavailable.
- Pickup stops require 2 photos.
- Drop-off stops require 1 photo.
- Travel stops require no photos.
- Confirming a stop automatically starts the next stop unless the driver selected rest.
- Completed stops/orders update dispatch visuals.
- Personal History shows driver DVIR and stop records with R2 photo preview.

### Driver Rest

Rest is built into the driver PWA.

Features:

- Rest button on active job can be toggled to `Rest after`.
- When the active stop/trip completes with rest selected, the server immediately creates an active rest record.
- Driver PWA shows the rest timer automatically.
- Next job remains pending while resting.
- Start job is blocked while an active rest exists.
- End rest time closes the rest record and returns to the next job.
- Rest records include start/end time in DB.

### Driver DVIR and Samsara Duty

Driver PWA forces DVIR around the day workflow.

Features:

- Pre-DVIR before assigned jobs.
- Four required photos: driver side, front, passenger side, back.
- Pre-DVIR must be confirmed by Samsara before jobs can start.
- Post-DVIR required after all assigned jobs are complete and before logout.
- DVIR photos are stored in R2 and reviewable in Dispatch DVIR module.
- Samsara vehicle assignment is based on the dispatch-assigned truck plate.
- Samsara primary/secondary usernames are stored in Dispatch Setup driver profile.
- Pre-DVIR sets the primary Samsara account on duty.
- If the driver works under 8 hours, post-DVIR sets primary account off duty.
- If the driver starts a job after 8 hours, the system switches to the secondary Samsara account:
  - secondary account assigned to the same truck;
  - secondary account set on duty;
  - primary account set off duty;
  - handoff response is saved in local DB.
- After handoff, post-DVIR sets the secondary account off duty.

## Dispatch

Main route: `/dispatch`

Dispatch menu links:

- Planning
- Monitor
- Statistics
- DVIR Photos
- Setup

Dispatcher login is required. Dispatch users should not have access to operator/control routes unless their role allows it.

### Dispatch Planning

Route: `/dispatch/planning`

Primary files:

- `server/public/dispatch.html`
- `server/public/dispatch.js`
- `server/public/dispatch.css`
- `server/src/dispatch-plan-repository.js`
- `server/src/dispatch-repository.js`
- backend APIs under `/api/dispatch/plans`, `/api/dispatch/orders`, `/api/dispatch/co-orders`

Dispatch Planning is a desktop layout for building date-specific truck plans.

Core planning features:

- Plan date selector. Each date has one unique plan.
- Confirm Plan button.
- Plans remain editable after confirmation.
- Auto-save with DB revision conflict detection.
- Multi-screen conflict prevention using plan revision.
- Undo and redo with Ctrl+Z / Ctrl+Y.
- Order pool tabs for SO, PO, TO, and CO.
- Search across open and planned orders.
- Planned orders appear with light purple background and cannot be dragged into another plan unless allowed by status/date logic.
- Search can navigate to a planned order on another date and switch to that plan.
- Drag/drop orders into loads.
- Drop position detection supports top/bottom/in-between insertion.
- Stop sequence can be reordered with constraints.
- A drop cannot occur before its related pickup.
- In-progress stops/orders cannot be removed from the load, but stop sequence can still be adjusted.
- Loads can be added, inserted after selected load, cleared, or deleted.
- Return loads can be added and deleted.
- Return load starts from previous load last stop and returns to selected yard.
- Every load start time can be adjusted. Time gaps can be represented as rest/wait blocks.
- Truck display sequence can be adjusted per dated plan.
- Default truck sequence can be adjusted in Dispatch Setup.

Load and route features:

- Loads belong to trucks.
- Drivers are assigned to trucks per plan through dropdown.
- One driver can only be assigned to one truck in a plan, but swaps are supported.
- Truck capacity is in pounds.
- Load weight uses item weight and sales quantity, not only estimated pallet count.
- Concurrent load weight is calculated across pickup/drop changes.
- Multiple pickup and multiple drop in one load is supported.
- Pickup points can be own yards, vendor yards, or transit pickup points.
- Google Maps route preview.
- Toll toggle per load; default avoids tolls.
- Travel time can include per-truck percentage adjustment.
- Route warnings show time-window issues, capacity issues, invalid sequence, and route problems.
- Completed stops show planned vs real arrival/leave and variance.
- Warning color uses light red to avoid confusion with active states.

Order features:

- SO, PO, TO, and CO planning.
- SO expected delivery date from NetSuite `custbody4`; fallback extraction from memo/note when needed.
- SO notes parsed for delivery address, date, time window, phone, and instructions.
- PO vendor yard matching from vendor and memo, with manual Set Yard fallback.
- Vendor yard address and hours are editable in Dispatch Setup.
- PO planning is vendor yard pickup to MBBS yard drop.
- TO planning uses from/to location.
- Split orders for SO and TO.
- Split logic uses conversion units where available, otherwise sales quantity and UOM.
- Unsplit available if all split child orders are unplanned.
- Group orders manually; group numbers use prefixes such as GOA/GOM and sorted suffixes to avoid collision.
- Grouped orders can be ungrouped only when no initialized CO blocks them.
- Grouped orders can initialize CO.
- Consolidate Pick / Link PO for SO shortages.
- Link PO checks PO line availability before connection.
- Linked PO quantities are deducted locally so operators are not surprised.
- CO local transit orders for moving SO/TO stock between yards before final delivery.
- CO can be initialized/cancelled.
- CO sequence logic enforces that CO happens before original order pickup.
- Invalid CO/order timing returns orders to pool with warning.

Operator bridge:

- Confirmed dispatch plans flag orders for operator delivery prep.
- Planned orders are promoted to operator planned list.
- Dispatch can request unpack when a packed order needs split adjustment.
- Operator request warnings/indicators are shown on the packed order.
- Parking spot and load information is shared to operators.

Audit and export:

- Every dispatch data update, drag/drop, load add/delete, return load, edit, split, group, CO, and plan action is written to dispatch audit.
- CSV export for shipped/planned-complete orders.
- Split planned orders export by original order only after all split children complete.

### Dispatch Setup

Route: `/dispatch/setup`

Primary file: `server/public/dispatch-setup.js`

Setup tabs:

- Drivers
- Trucks
- Own Yards
- Vendor Hours
- Samsara
- Parser Rules
- Dispatch Log
- Ollama Audit

Driver setup:

- Register/update drivers.
- Name, license class, license number, login, password.
- Samsara primary username.
- Samsara secondary username.
- Fixed stop time in own yard.
- Fixed stop time in vendor yard.
- Fixed stop time in delivery.
- Delivery minutes per pallet.
- Test Samsara API.
- Find primary/secondary Samsara driver by username.

Truck setup:

- Register/update trucks.
- Plate number.
- Weight capacity.
- Travel time percentage adjustment.
- Default truck sequence drag/drop.

Own Yard setup:

- Yard code/name.
- NetSuite internal location ID.
- Address.
- Latitude/longitude where available.
- Used by routes, TO, CO, return load, own-yard time rules, and operator location list.

Vendor Hours:

- Vendor/yard address maintenance.
- Per-day active/closed setting.
- 24-hour start/end format such as `0700-1900`.
- Used for PO yard matching and stop time-window warnings.

Parser Rules:

- Maintains labels for address/time extraction.
- Supports labels in English and Chinese.
- Configures fuzzy terms such as PM or whole-day.
- Re-parse functions for missing delivery time and all non-shipped delivery orders.

Ollama Audit:

- Shows local model input/output for dispatch note parsing.
- Click record to expand result details.

Dispatch Log:

- Filter and review dispatch action audit.
- Includes planner updates, drag/drop, load changes, and manual edits.

### Dispatch Monitor

Route: `/dispatch/monitor`

Primary file: `server/public/dispatch-monitor.js`

Features:

- Live map of trucks using Samsara vehicle locations.
- Always shows current truck license plate.
- Tracks only current local truck plates.
- Shows active load/order/stop blob for trucks with started loads.
- Refreshes truck pins without rerendering the whole map.
- Clicking a truck focuses the map on that truck.
- Uses Samsara speed converted to km/h.
- Shows last movement speed in truck blob.
- Stores truck location history in DB when geocode/location changes.
- Draws past route/history for each truck.
- Uses distinct route and truck colors prepared for about 20 trucks.
- Smaller flatbed-style truck marker.
- Shows own yard and vendor yard reference locations on the map.

### Dispatch Statistics

Route: `/dispatch/statistics`

Primary files:

- `server/public/dispatch-statistics.js`
- `server/src/dispatch-statistics-repository.js`

Features:

- Date range filter.
- Driver performance summary.
- Average own-yard stop time.
- Average vendor-yard stop time.
- Average delivery stop time.
- Average delivery minutes per pallet.
- Planned vs actual overrun by driver/load/stop.
- DVIR completion/driver job data basis.
- Numeric cards and chart-style visual summaries.

### Dispatch DVIR Photos

Route: `/dispatch/dvir`

Primary file: `server/public/dispatch-dvir.js`

Features:

- Date filter.
- Left-side DVIR record list.
- Right-side photo preview panel.
- Pre-trip and post-trip DVIR records.
- R2-backed photo thumbnails and full preview.
- Driver/truck/plan date metadata.

## Control Panel

Route: `/control`

Primary files:

- `server/public/control.html`
- `server/public/control.js`
- `server/public/control.css`

The Control Panel is for admin/supervisor work.

Sections:

- Dashboard
- Account Management
- Order Locks
- Item Classification
- Sync Settings
- Operator Warnings
- Loaded Export
- Cycle Count Review
- Operator Load Records
- Audit Log

### Dashboard

Features:

- Summary cards for active accounts, classified items, audit rows, sync status, warnings, locks, cycle counts, load records, and loaded export count.
- Quick refresh.
- Inventory sync shortcut.

### Account Management

Features:

- Create operator, dispatcher, and admin accounts.
- Set display name, username, role, password.
- Activate/deactivate accounts.
- Admin can change another account password.

### Order Locks

Features:

- View current preparing locks.
- Shows order, type, location, status, locked by, start time, and draft line count.
- Release individual stuck locks.
- Release all locks.
- Intended for tablet crash/app close/server restart recovery.

### Item Classification

Features:

- Search item master.
- View internal ID, name, description, total on hand, total available.
- Edit local product type, brand, series.
- Manual edits are preserved against automatic classification updates.
- Sync inventory/item data from NetSuite.
- Classification rules exist for prefixes such as UNI, BWS, PER, BC, ARCH, BNS, OAK.

### Sync Settings

Features:

- Auto/manual sync mode.
- Sync status, running flag, source, last started/finished, error.
- Max runtime control.
- Start sync in background and poll status.
- Stop/Clear sync running flag.
- Reconcile NetSuite progress for completed/partial SO, PO, TO.
- Connect NetSuite OAuth.
- Switch env file such as production `.env` and sandbox `.env.old` without restart when DB connection remains safe.
- Clear all operational order data for development while preserving accounts, setup, item master/classifications, vendor yards, parser rules, and inventory.

### Operator Warnings

Features:

- Shows records reported by operators.
- Warning detail includes reference, operator, reason, details, and photos when available.
- Mark warnings handled/resolved.

### Loaded Export

Features:

- View loaded and partially loaded SO/TO records.
- Filter by from/to date and yard.
- Search across all dates/yards by order/customer without affecting CSV filter.
- Detail panel shows loaded lines and photos.
- Export CSV columns: order, item name, sales quantity, sales UOM, location.

### Cycle Count Review

Features:

- Review submitted blind count records.
- Shows operator, submitted time, line count, total absolute variance.
- Details include SKU, location, counted units, counted total, system on hand, system available, variance, and conversion.

### Operator Load Records

Features:

- Review local load/photo records posted by operators.
- Shows order reference, status, operator, created time, payload/response/photo indicator.

### Audit Log

Features:

- Date/time filters.
- Actor dropdown filter.
- Action dropdown filter.
- TranID filter.
- Limit selection.
- Shows operator, sync, dispatch, and system activity.

## NetSuite Integration

Primary files:

- `server/src/netsuite.js`
- `server/src/order-sync-repository.js`
- `server/src/sync-delivery.js`
- `server/netsuite-order-webhook-user-event.js`
- `server/netsuite-order-webhook-scheduled.js`

Features:

- OAuth connection to NetSuite REST/SuiteQL.
- SuiteQL sync for SO, PO, TO, item, inventory, conversion, weight, and status data.
- Manual sync and automatic sync.
- Background sync with progress polling.
- Webhook endpoint: `POST /api/webhooks/netsuite/order`.
- Lightweight User Event for SO, PO, and TO queues an asynchronous Scheduled
  Script, preventing webhook latency or failure from blocking approval workflows.
- SO webhook has delayed status refresh to handle NetSuite auto-approval workflow.
- PO webhook also supports delayed status update where needed.
- Sync retrieves pending and partially completed orders with remaining quantity.
- SO statuses include pending fulfillment and partially fulfilled.
- PO statuses include pending receipt and partially received.
- TO sync handles fulfillment-side and receiving-side remaining quantities.
- SOV orders are included only when pending fulfill; SOT orders are excluded per business rule.
- Order line IDs use stable NetSuite line unique keys where available.
- Fractional quantities are supported.
- Item weights are synced and used for dispatch load weight.
- NetSuite progress reconcile can mark old completed/partial records as packed/loaded/shipped or received locally.

## Samsara Integration

Primary file: `server/src/samsara.js`

Features:

- API token based Samsara connection.
- Test Samsara API connection from Dispatch Setup.
- Find Samsara drivers by username.
- Find Samsara vehicles by license plate.
- Create driver auth token endpoint exists for testing/integration.
- Assign driver to vehicle using dispatch-assigned truck plate.
- Set driver HOS duty status ON_DUTY/OFF_DUTY.
- Create mechanic DVIR records from MBBS PWA inspection.
- Read Samsara vehicle locations.
- Read HOS clocks.
- Stream DVIR records for verification/review.
- Driver dual-account handoff after 8 hours using primary/secondary Samsara usernames.

## Photo Storage and Preview

Primary files:

- `server/src/photo-upload.js`
- `server/src/migrate-photos-to-r2.js`
- `server/src/reupload-r2-photos-per-reference.js`
- Cloudflare Worker code lives outside this repo in the worker project.

Features:

- PWA asks Node server for upload token.
- Upload token is short-lived.
- PWA uploads photo to Cloudflare Worker.
- Worker stores file in R2.
- Server stores `r2://...` references in DB.
- Server preview endpoint returns image content for authenticated users.
- Thumbnail preview and full-size lightbox are used in operator history, driver history, loaded export, and DVIR review.
- Migration scripts exist to move older local/base64 photo data to R2.

## Database and Data Model

Primary migrations:

- `server/migrations/001_baseline_current_schema.sql`
- `server/migrations/002_dispatch_plan_revision.sql`
- `server/migrations/003_operator_saved_delivery_orders.sql`
- `server/migrations/004_local_co_source_pack_fields.sql`
- `server/migrations/005_explicit_co_order_mirror.sql`
- `server/migrations/006_driver_rest_records.sql`
- `server/migrations/007_driver_samsara_dual_account.sql`

Major data areas:

- Canonical order tables for Sales Orders, Transfer Orders, Purchase Orders, and CO orders.
- Separate order line tables with conversion, loaded, packed, received, and NetSuite remaining quantity data.
- Dispatch plans and plan snapshots.
- Dispatch audit log.
- Delivery/operator audit log.
- Operator accounts and roles.
- Operator locks and requests.
- Saved delivery orders.
- Cycle count draft/submission tables.
- Inventory item master, quantities, conversions, classifications, and weights.
- Driver day records, job records, rest records, DVIR photos, and Samsara status responses.
- Vendor yard and parser configuration.
- Photo references stored as R2 refs where migrated/uploaded.

## Realtime and Notifications

Features:

- `/api/events` server-sent events endpoint.
- Operator PWA listens for delivery/order/receiving updates and urgent delivery notifications.
- Dispatch planning/setup listens for plan/setup/audit updates.
- Driver PWA listens for plan/job/rest/load updates.
- Notifications avoid local-cache-only memory so re-planned urgent orders can notify again.
- Operator notification includes custom ding sound and PWA notification support.

## Test and Maintenance Tools

Server scripts:

- `npm run migrate` - apply DB migrations.
- `npm run start` - start server.
- `npm run dev` - start server with Node watch.
- `npm run test:rollback-endpoints` - rollback test harness for mutating endpoints.
- `npm run test:sync-shape` - sync shape simulation harness.
- `npm run sync:delivery` - delivery sync helper.

Maintenance features:

- Control Panel clear order data for development resets operational records while keeping setup/configuration.
- Control Panel stop sync clears stuck sync running state.
- Control Panel release locks clears stuck operator preparing locks.
- R2 photo migration and reupload scripts.
- Dispatch group-order ID migration script.

## Known Implementation Notes

- Return module has a visible operator menu entry, but the production code should be reviewed before operational use because the current route detail is less developed than Delivery Prep, Receiving, Customer Pickup, Cycle Count, Dispatch, Control, and Driver.
- `/delivery` remains only as a compatibility route redirecting to `/operator`.
- The app uses local server-side configuration and data files for dispatch setup, env switching, and persisted setup values; keep env files and API tokens private.
- Installed PWAs can cache old assets until service worker cache versions are bumped and the app is fully closed/reopened.
