# MBR Contract

MBR is independent business functionality in the existing application. Its
only shared services are staff authentication, PostgreSQL, navigation, and
installed PDF/image tooling. It does not create or update NetSuite, MBT, SOR,
inventory, Field Sales, or existing Sales records.

## Activation

1. Deploy the updated server and public assets and apply migration
   `285_mbr_contracts.sql` using the existing migration/release procedure.
2. Set `MBR_CONTRACTS_ENABLED=true` in the application environment. It defaults
   to false. Set `APP_BASE_URL` to the public HTTPS application URL.
3. In Admin → Accounts, create or grant **MBR Sales** (`mbr_sales`) accounts.
   MBR Sales and admins manage the shared contract list at `/mbr/contracts`.

The browser generates the customer-facing copy link on the actual application
origin; direct API callers receive a link based on `APP_BASE_URL`.

The link encryption key is generated on first use at
`data/.mbr-signing-link-key`, mode 0600, inside the existing persistent app data
volume. Include this key and the database in operational backups. Keep them
together through releases; the key permits staff to retrieve already-issued
links. Customer authorization uses hashes, not decryption of that key.

Disable MBR with `MBR_CONTRACTS_ENABLED=false` and restart/reload the application
environment to reverse activation. Retain the additive tables, signed PDFs,
account-role support, and link key. Returning to an older binary that does not
recognize `mbr_sales` also requires retaining the new role compatibility in
authentication; simply removing that compatibility would break account reads.

## Workflow

Sales saves one equipment contract, then generates and copies the link to send
through their usual messaging channel. A pending save without a link has no
deadline. The first generated link starts the positive whole-day duration,
default three days. Copying preserves its deadline. Every saved pending edit
creates a new version, keeps the same link, and restarts the duration.

Customers use the link without an account, review the complete agreement,
choose Accept or Decline protection, confirm full-agreement consent, and draw
a signature. The protection surcharge is the supplied agreement's fixed 15%.
CAD rates and refundable deposit are terms, not a calculated quote or invoice.

A stale customer submission returns `MBR_CONTRACT_CHANGED` (409). The customer
page reloads the current agreement and clears previous consent, choice and
signature. Failed network requests retain the drawing and use the same retry
identity. Statuses are only pending, completed and expired.

Deadlines are enforced at the database boundary after obtaining the contract
lock. A one-minute, non-overlapping sweep records automatic expirations.
Renewal keeps the contract number, appends a version, replaces the signing link,
and preserves expiry history. Old links return 410. Completed agreements are
immutable; their links retain read-only review and PDF download access.

Every signed agreement stores its complete source template, entered fields,
rendered clause text, protection choice, signing name, server time, signature,
signature/PDF hashes and completed PDF in one transaction. Separate initials
are replaced by the explicit full-agreement acknowledgement. All 14 sections
come from the user's original DOCX; its logo and source hash are preserved.

## Interfaces

Staff uses bearer authentication under `/api/mbr`: `GET /status`,
`GET/POST /contracts`, `GET/PATCH /contracts/:id`,
`POST /contracts/:id/link`, `POST /contracts/:id/renew`,
and `GET /contracts/:id/pdf`. Edits, renewal and link retrieval pass `revision`.
Monetary input fields are decimal CAD strings; stored amounts are integer cents.

Public requests use `X-MBR-Contract-Token` under `/api/mbr/public`:
`GET /contract`, `POST /sign`, and `GET /pdf`. Signing passes `revision`,
`protectionPlanAccepted`, `consent`, `signerName`, `signatureDataUrl` (PNG), and
a UUID-v4 `submissionId`. No staff token, customer account or email is required.
The invitation token is in the URL fragment and is never sent in a request URL.

Public inputs, image dimensions, request rates and limiter storage are bounded.
Cross-origin browser signing is refused. Reverse proxies must pass the public
Host and overwrite X-Forwarded-Proto with the request's actual protocol.
Contract pages and API responses use no-store; the existing service workers
explicitly exclude MBR pages and assets.

## Reproduce validation

From the repository root run:

```sh
python3 server/tools/mbr-contract-gauntlet.py all
```

The runner uses the standard isolated Compose configuration, `mbbs-tests.slice`,
bounded CPU/memory/PIDs/tmpfs, disposable-test labels, and finally/SIGINT/SIGTERM
teardown. It removes all task containers, networks and disposable storage on
every exit, checks ps and ps -a, and verifies production health. Test databases
are never retained. Evidence is in `server/test-artifacts/mbr-contract`.

This host reuses a copy of already-installed toolchain/browser caches. To run
elsewhere, build the repository's standard Dockerfile.test `test-e2e` image and
set `MBR_TEST_IMAGE` to that image. `MBR_TEST_NODE_MODULES` optionally selects
an existing installed dependency cache. No new dependencies were added.

The shared regression check compares against a run of the preserved original
integration files. The known existing staff-login redirect failure is reported
and must not be treated as passing; any additional failure blocks the runner.
