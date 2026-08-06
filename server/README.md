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
