# MBBS Yard Server

Local server for the real MBBS Yard Operator Application.

The tablet app should call this server. This server calls NetSuite and stores operator, delivery, cycle count, and inventory data in PostgreSQL.

## First Setup

1. Install Node dependencies:

   ```powershell
   cd server
   npm install
   ```

2. Copy `.env.example` to `.env`.

3. Fill in:

   - `DATABASE_URL`
   - `NETSUITE_CLIENT_ID`
   - `NETSUITE_CLIENT_SECRET`
   - `NETSUITE_REDIRECT_URI`
   - `NETSUITE_AUTH_URL`
   - `NETSUITE_TOKEN_URL`
   - `NETSUITE_REST_BASE_URL`
   - `GOOGLE_MAPS_API_KEY` for dispatch route preview maps
   - `SAMSARA_API_TOKEN` for server-side Samsara API calls

4. Create the PostgreSQL database:

   ```powershell
   createdb mbbs_yard
   npm run migrate
   ```

5. Start the server:

   ```powershell
   npm run dev
   ```

6. Open the control panel and create the first admin account:

   ```text
   http://localhost:3000/control
   ```

7. Open this once in the browser to connect NetSuite:

   ```text
   http://localhost:3000/api/auth/netsuite/start
   ```

8. Sync delivery orders:

   ```powershell
   npm run sync:delivery
   ```

## Tablet PWA

The operator tablet app is packaged as an installable PWA:

```text
http://localhost:3000/operator
```

For real Win11 or Android tablets outside the same local network, publish this server through a stable HTTPS URL such as:

- a domain with a reverse proxy and TLS certificate;
- a secure tunnel service;
- a VPN that lets tablets reach the server with HTTPS.

Browser install prompts generally require HTTPS, except for localhost during development. Keep NetSuite credentials only on this server.

## Local APIs

```text
GET  /health
GET  /operator
GET  /delivery  -> redirects to /operator
GET  /control
POST /api/auth/login
GET  /api/auth/me
POST /api/auth/logout
GET  /api/operators
POST /api/operators
GET  /api/delivery/audit
GET  /api/delivery/orders
GET  /api/delivery/orders/:id
POST /api/delivery/sync
POST /api/delivery/orders/:id/sync
POST /api/delivery/orders/:id/status
POST /api/delivery/orders/:id/lines/:lineId/confirm
POST /api/delivery/orders/:id/lines/:lineId/packed-quantity
POST /api/delivery/orders/:id/lines/:lineId/unpack
POST /api/delivery/orders/:id/unpack
POST /api/delivery/orders/:id/prepared
POST /api/webhooks/netsuite/order
POST /api/webhooks/netsuite/customer
POST /api/inventory/sync
GET  /api/inventory/facets
GET  /api/inventory/items
GET  /api/cycle-count/draft
POST /api/cycle-count/lines
POST /api/cycle-count/submit
```

Delivery order list supports filters:

```text
GET /api/delivery/orders?locationId=1&status=active
GET /api/delivery/orders?locationId=13&status=packed
```

## NetSuite Customer Webhook

The customer webhook writes saved NetSuite customers to the shared customer
master and Return customer directory in one transaction. Customers become
available to existing customer searches (including special orders and NetSuite
customer selection) as soon as the response succeeds. This does not create
separate field-sales prospect records or write back to NetSuite.

1. Deploy the application containing `src/netsuite-customer-webhook*.js` and the
   route in `src/server.js`. Existing customer-master migrations must be applied.
   No additional migration is required.
2. Keep `NETSUITE_ACCOUNT_ID` set to the source NetSuite account and
   `NETSUITE_WEBHOOK_SECRET` set to the existing private shared secret in the
   application's active environment. Never put the secret in the script source.
3. Upload `netsuite-customer-webhook-user-event.js` to NetSuite and create a
   **User Event Script** with a **Customer** deployment, status **Released**.
   Enable Create, Edit and XEdit and the needed execution contexts (UI, web
   services and CSV imports). CSV imports must run server SuiteScript.
4. Add these script parameters and set their deployment values:

   | Parameter ID | Value |
   | --- | --- |
   | `custscript_mbbs_customer_webhook_url` | `https://YOUR-APPLICATION/api/webhooks/netsuite/customer` |
   | `custscript_mbbs_customer_webhook_secret` | Same private value as `NETSUITE_WEBHOOK_SECRET` |

5. Save a customer and confirm the script execution log says
   `MBBS customer webhook sent` with HTTP 200. Search for its customer number in
   the application. For previously saved customers, save them again to send
   their current snapshot.

The sender reloads the saved record for inline edits, since NetSuite supplies
only edited fields in an XEdit event. See Oracle's
[afterSubmit documentation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4407992281.html).
The deployment role needs access to Customer, Currency and customer addresses.

The endpoint requires `Content-Type: application/json` and the
`x-mbbs-webhook-secret` header. It accepts at most 256 KB. Example body:

```json
{
  "schemaVersion": "netsuite-customer/v1",
  "recordType": "customer",
  "eventType": "create",
  "accountId": "YOUR_NETSUITE_ACCOUNT",
  "customer": {
    "netsuiteId": "12345",
    "entityNumber": "C12345",
    "legalName": "Example Customer Ltd",
    "displayName": "Example Customer Ltd",
    "currency": "CAD",
    "email": "customer@example.com",
    "phone": "5550101234",
    "active": true,
    "terms": "Net 30",
    "taxStatus": "",
    "creditStatus": "AUTO",
    "sourceModifiedAt": "2026-10-01T12:00:00.000Z",
    "addresses": [],
    "subsidiaries": []
  }
}
```

Required snapshot fields must be present even when empty. `currency` is the
actual three-letter ISO code, not a NetSuite currency ID or display name.
Use the record's last modification time in UTC, not the delivery time.
Responses are 200 with `action: created|updated|unchanged|ignored`, 400 for an
invalid payload, 401 for invalid credentials, 403 for an incorrect account or
mirror consumer, 409 for conflicting snapshots at the same source timestamp,
413 for oversized input, and 503 for missing configuration or a save failure.
Duplicate delivery is safe; stale events cannot replace newer data. Conflict
details and successful applies are retained in the existing sync/audit tables.

The script logs failed delivery without preventing the NetSuite save. It has
no durable outbound retry queue: after correcting a configuration or temporary
failure, save the customer again. A 409 requires inspecting the customer sync
conflict and sending a newer authoritative snapshot. Inactive customer updates
remove active selection and the Return projection. Deletes, leads and prospects
are skipped; existing child addresses/contacts are not removed by omission.

Reproduce validation from the repository root with
`bash server/tools/customer-webhook-gauntlet.sh`. Tests use synthetic customers
inside bounded disposable Compose containers and remove the database afterward.

## NetSuite Webhook

Set a shared secret in the active env file:

```text
NETSUITE_WEBHOOK_SECRET=change-this-to-a-long-random-value
```

Endpoint:

```text
POST /api/webhooks/netsuite/order
Header: x-mbbs-webhook-secret: <NETSUITE_WEBHOOK_SECRET>
```

The endpoint accepts Sales Order, Purchase Order, and Transfer Order payloads. It updates the local SO/TO delivery tables, PO/TO receiving tables, and sends realtime app events so operator/dispatch screens can refresh without waiting for a full sync.

For Sales Orders, the server also schedules a lightweight NetSuite status check
10 seconds after the webhook is received. This catches approval workflows that
change the order from Pending Approval to Pending Fulfillment shortly after the
User Event webhook fires.

For the simplest one-script setup, upload
`server/netsuite-order-webhook-user-event-direct.js` and deploy it as a User
Event Script on Sales Order, Purchase Order, and Transfer Order. Add these two
script parameters:

```text
custscriptmbbs_webhook_url=https://your-server.example/api/webhooks/netsuite/order
custscriptwh_webhook_secret_i=<NETSUITE_WEBHOOK_SECRET>
```

For a manual Sales Order approval, open the User Event deployment's **Context
Filtering** tab and ensure:

- Event Type includes `Approve` (using all event types is also valid).
- Execution Context includes `User Interface`.
- The deployment is Released, applies to Sales Order, and is not restricted to
  an audience that excludes the approving user.

After one manual approval, the NetSuite execution log should contain `MBBS
webhook invoked` followed by `MBBS webhook sent`. If `invoked` is absent, the
deployment did not run; check the filters above. If `invoked` exists without
`sent`, open the `MBBS webhook missing parameters`, `failed`, or `exception` log
detail. The direct option makes HTTPS synchronously, so the approval waits for
the request to finish.

For higher transaction volume, the optional two-script setup avoids holding the
approval request open while NetSuite calls the external server:

1. Upload `server/netsuite-order-webhook-scheduled.js` and create a Scheduled
   Script with script ID `customscript_mbbs_order_webhook_worker`.
2. Add these Scheduled Script parameters as Free-Form Text fields:

```text
custscriptmbbs_wh_record_type
custscriptmbbs_wh_record_id
custscriptmbbs_wh_event_type
custscriptmbbs_wh_url
custscriptmbbs_wh_secret
```

3. Create at least one deployment with status `Not Scheduled`. For accounts
   with frequent transaction updates, create multiple deployments so NetSuite
   can select an available worker.
4. Upload `server/netsuite-order-webhook-user-event.js` and deploy it as a User
   Event Script on:

- Sales Order
- Purchase Order
- Transfer Order

User Event script parameters:

```text
custscriptmbbs_webhook_url=https://your-server.example/api/webhooks/netsuite/order
custscriptwh_webhook_secret_i=<NETSUITE_WEBHOOK_SECRET>
```

The User Event queues the Scheduled Script and returns immediately. Leave
`custscriptmbbs_webhook_worker_deploy` empty to let NetSuite choose an available
worker deployment. If the Scheduled Script uses a different script ID, add
`custscriptmbbs_webhook_worker_script` to the User Event and set that value.

The Scheduled Script parameters receive their values from the queued task; do
not place the webhook secret directly in the script source file.

The script also accepts the older parameter IDs `custscript_mbbs_webhook_url` and
`custscript_mbbs_webhook_secret`, plus a few typo-tolerant variants. These
parameters must be on the User Event Script or its deployment for the same script
record that runs on Sales Order, Purchase Order, and Transfer Order. If the
execution log says `urlConfigured:false` or `secretConfigured:false`, open the
latest `MBBS webhook missing parameters` log detail and compare the displayed
`scriptId`, `deploymentId`, and accepted parameter IDs with the parameter record
you edited.

After changing sandbox/production env in Control Panel, reconnect NetSuite if OAuth credentials/account changed.

## Notes

- Keep `.env` private.
- Do not put NetSuite credentials into tablet code.
- Restrict the Google Maps browser key in Google Cloud by HTTP referrer, for example `https://your-domain.example/*` and `http://localhost:3000/*` during testing.
- Delivery APIs require operator login. Send `Authorization: Bearer <token>` from the PWA.
- Operator updates and NetSuite sync summaries are written to `delivery_audit_log`.
- If tablets are not on the same network, do not rely on a LAN IP. Use a stable HTTPS URL.
