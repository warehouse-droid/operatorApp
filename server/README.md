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

## Notes

- Keep `.env` private.
- Do not put NetSuite credentials into tablet code.
- Restrict the Google Maps browser key in Google Cloud by HTTP referrer, for example `https://your-domain.example/*` and `http://localhost:3000/*` during testing.
- Delivery APIs require operator login. Send `Authorization: Bearer <token>` from the PWA.
- Operator updates and NetSuite sync summaries are written to `delivery_audit_log`.
- If tablets are not on the same network, do not rely on a LAN IP. Use a stable HTTPS URL.
