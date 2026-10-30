# IR/IF posting response RESTlet

Status: **deployed by the user as script 507, deployment 1; both NetSuite write
parameters enabled and verified**. An authenticated health GET returned HTTP 200
with version 1 in PRODUCTION. Application activation is controlled separately by
the feature gate below; the deployment result is the authority for rollout state.
Uploading or enabling the RESTlet alone does not redirect application requests.

The app integration was deployed and enabled on 2026-10-21 at 05:19 UTC. See
`server/deployments/ifir-posting-integration-20261021/deployment-result.json`
and `server/test/ifir-posting-integration-evidence.md` for the verified release.

Upload `server/netsuite-ifir-posting-restlet.js` as a SuiteScript 2.1 RESTlet.
It transforms PO to IR, SO to IF, TO to IF, or TO to IR, saves the transaction,
then reloads it inside NetSuite and returns its actual assigned number and saved
verification data. This removes the need for a second HTTP read on a successful,
complete, verified response once the application is switched to this endpoint.
Internal NetSuite record reads still occur.

## Application feature gate and rollback

The original native transform functions and record-verification flow are retained.

**Current routing: original flow.** The user turned the RESTlet routing off on
2026-10-21 and will enable it manually later. Refresh **Admin → Feature Gates**
and use **IR/IF posting via RESTlet** (`netsuite_ifir_posting_restlet`): **On**
uses the RESTlet for supported postings; **Off** uses the original flow. This
database setting is audited and read on every attempt, without an app restart.
The migration seeds it off and preserves existing choices when rerun.

The deployment settings below remain required ceilings for the Admin toggle:

```dotenv
NETSUITE_IFIR_POSTING_ENABLED=true
NETSUITE_IFIR_POSTING_RESTLET_URL=https://6518947.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=507&deploy=1
```

The deployment gate defaults to `false`. Set `NETSUITE_IFIR_POSTING_ENABLED=false` in the
active application configuration and apply/restart using the normal configuration
workflow to return new supported attempts to native posting. Both paths retain
the existing command leases, external IDs, source checks and recovery state.
Toggling the gate does not release an uncertain posting or authorize reposting it.
The two NetSuite script checkboxes only permit script writes; they are separate
from the application's routing gate.

For this release, the active override is
`server/deployments/ifir-posting-integration-20261021/compose.release.yml`.
Change its `NETSUITE_IFIR_POSTING_ENABLED` value to `"false"` and recreate only
the app service using its active Compose files. Editing an earlier `.env` file
alone does not override the explicit value in this release file.

When enabled, the shared operator adapter and automatic SO fulfillment use the
RESTlet for eligible PO→IR, SO→IF, TO→IF and TO→IR requests. Successful saved
records are still checked by the existing verifier. The normal success path uses
the response record and source evidence without an additional transaction GET.
Kits, explicit inventory detail, unsupported payload fields and combined SO
fulfillments with multiple inventory locations retain native routing. Existing
split-location handling remains; eligible individual parts can use the RESTlet.
Other transaction APIs and dedicated special-order workflows remain unchanged.

After a POST timeout, malformed response or ambiguous save, recovery reads the
existing transaction; it never falls back to a second native POST. Only an explicit
unsupported-kit/inventory response proving no save was attempted permits native
posting within that attempt. Disabling the NetSuite checkboxes while the app gate
is on stops RESTlet posting; switch the app gate off to use native posting.

The scoped release tooling is `server/tools/ifir-integration-release.py`; its
manifest and image rollback are under
`server/deployments/ifir-posting-integration-20261021/` when rollout completes.

## Historical compatibility evidence

The final operational replay inspected eight completed postings. Seven RESTlet
requests returned `outcome: "existing"` with their original IDs and document
numbers; the kit was verified through the native reader. Zero new transactions
were created. A preceding kit replay demonstrated `IFIR_INCOMPLETE_READBACK`,
which is why kits stay on the native route.

The replay includes a sales order containing a Discount line, a purchase receipt
for MBBS-Special Order, package-bearing IF/IR requests, and all four allowed
source/transaction pairs. Saved item IDs, quantities, units, source and external
IDs passed the existing verifier. Requested IF package fields matched. In this
account, both the native API and RESTlet return no package columns on IR; these
stay null rather than being fabricated from the request. Receipt verification
retains the existing material quantity/item/unit checks.

Operational evidence is under
`server/artifacts/ifir-posting-integration-20261021/`. Replay validates existing
record lookup/readback and response compatibility, not fresh production saves or
save-time workflow behavior. Unit tests exercise transform/save through simulated
SuiteScript boundaries; no arbitrary production order is created for testing.

## Deployment

1. Create a **new** RESTlet script and deployment for this file. Suggested IDs:
   `customscript_mbbs_ifir_posting` and `customdeploy_mbbs_ifir_posting`.
2. Add two script parameters of type Checkbox, both defaulting to unchecked:

   | Parameter ID | Purpose |
   | --- | --- |
   | `custscript_mbbs_ifir_writes_enabled` | Allows the POST entry point to save transactions. |
   | `custscript_mbbs_ifir_allow_production` | Additionally allows writes in a production account. |

3. Restrict deployment access to the existing integration identity/role. It needs
   the relevant transaction creation and source/item read permissions. Use the
   existing OAuth setup with the RESTlets scope enabled for both the integration
   and its token. The REST Web Services scope alone does not authorize RESTlets.
   [Oracle OAuth scope documentation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157771863841.html).
4. Call the deployment URL with GET. This is read-only and returns contract version,
   activation settings, environment and supported transforms. Health does not
   prove write permissions, custom field availability or workflow compatibility.
5. In a sandbox, enable the writes checkbox and validate the cases below. Leave
   the production checkbox off. Production deployment can be uploaded with both
   checkboxes off while the app continues using the old flow.
6. After successful sandbox proof, prepare the app change to use this deployment
   URL and its response. Do not replace the current endpoint merely because the
   new file has been uploaded. Enable production only as part of that rollout.

Use the external URL supplied by NetSuite on the deployment record; the script
does not contain credentials, account IDs or deployment URLs.

## POST request

Send `Content-Type: application/json`. IDs and numbers below are illustrative.
Use the durable external ID already assigned to the posting command, including
any existing per-location suffix. Preserve the same key across retries.

```json
{
  "action": "post",
  "sourceOrderKind": "PO",
  "transactionType": "IR",
  "sourceNetSuiteId": 901,
  "payload": {
    "externalId": "MBBS-OP-test-1",
    "memo": "PO901",
    "custbody9": "PO901",
    "item": {
      "items": [
        { "orderLine": 1, "itemReceive": true, "quantity": 2, "location": 15, "custcol_plt": 1 },
        { "orderLine": 2, "itemReceive": false, "location": 15 }
      ]
    }
  }
}
```

`orderLine` must identify NetSuite's source order line, not the item ID or array
position. All selections are explicit booleans. Unrequested material lines are
deselected. Native auto-included, non-accruing purchase Other Charge lines are
preserved when omitted and returned with their source evidence.

Supported body fields: `externalId`, `memo`, `custbody9`, and, for IF only,
`inventoryLocation` and `shipStatus` (`A`, `B`, `C`). Location values accept a
positive numeric ID or `{ "id": "15" }`.

Supported item fields: `orderLine`, `itemReceive`, `quantity`, `location`,
`custcol_plt`, `custcol_lyr`, `custcol_sec`, `custcol_pcs`. Unknown fields are
rejected before save rather than silently discarded. Payloads/records exceeding
1,000 lines are rejected without truncation. Native mandatory-field checks stay
enabled. Transaction numbers cannot be supplied or fabricated by the caller.

## Response and eventual app consumption

A complete response has:

```json
{
  "ok": true,
  "contractVersion": 1,
  "complete": true,
  "requiresReconciliation": false,
  "outcome": "created",
  "id": 8001,
  "tranId": "IR000123",
  "record": {
    "id": 8001,
    "tranId": "IR000123",
    "externalId": "MBBS-OP-test-1",
    "transactionType": "IR",
    "recordType": "itemreceipt",
    "createdFromId": 901,
    "item": { "items": [] }
  },
  "source": { "id": 901, "lines": [] }
}
```

The arrays above are abbreviated for readability; a complete success requires
saved positive lines. A full fixture response is generated at
`server/artifacts/ifir-posting-restlet-20261021/final/example-response.json`.

| Data | Returned fields |
| --- | --- |
| Saved identity | `record.id`, `tranId`, `externalId`, `transactionType`, `recordType`, `createdFromId` |
| Saved header | `status`, `shipStatus`, `tranDate`, `memo`, `custbody9`, `location` |
| Saved item lines | `orderLine`, `line`, `lineUniqueKey`, item ID/name/type, `itemReceive`, `quantity`, location, units and pack columns |
| Purchase charge evidence | `itemSubtype`, `generateAccruals`, `itemUnitPrice`, `itemFxAmount`, `orderDoc`, plus source PO line IDs, item, quantity, rate, location and unit |
| Inventory detail | Saved assignments, when present after save, including lot/serial number, bins, statuses and quantity |
| Retry outcome | `outcome: "existing"` for an already saved external ID; no second save |

Optional/unavailable values are `null` or empty strings. They are never replaced
with requested quantities, computed charge amounts or a guessed document number.
`complete` describes a usable readback, **not** a successful comparison with the
app's requested business operation.

For the later application integration:

1. Authenticate the response from the configured account's deployment and require
   `contractVersion === 1`, `ok === true`, `complete === true` and matching outer
   and inner IDs.
2. Pass `response.record` and `response.source` to the existing
   `verifyPurchaseReceiptWithCharges(step, record, source)` check. This already
   verifies external ID, source order, transaction type, items, quantities,
   locations, units and eligible additional purchase charges. Run it before
   marking the local command completed; do not trust `ok` or the number alone.
3. Persist the verified internal ID and `tranId`, and reuse the saved record for
   downstream work. Skip the usual external `fetchById` only for this verified
   response. Keep existing source checks, command leases, recovery and split-IF
   ownership logic.

## Errors and duplicate recovery

RESTlet error responses can have HTTP 200 with `ok: false`; check the JSON body.
Errors contain `code`, `message`, `stage`, `id` when known, `ambiguous`,
`requiresReconciliation` and `postingNotAttempted`.

A save followed by a read failure returns the known ID with
`requiresReconciliation: true`. A save exception may have committed and is
treated as ambiguous. Resolve that ID or the original external ID before any
further posting. A network timeout is also ambiguous even if no JSON arrived.
Never fall back to a second POST with a new external ID after an uncertain result.

The RESTlet first searches for the external ID across transactions. It checks
the source and type and returns saved evidence for the existing transaction.
It also attempts that recovery after a save exception. Concurrent duplicates
rely on NetSuite's external-ID uniqueness; the local fixture simulates this
boundary, while a sandbox race remains required evidence. NetSuite documents
external IDs as unique across the transaction record group.
[Oracle external-ID rules](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N3436356.html).

Reusing a key with changed quantities does not update the original transaction:
the response contains its original saved quantities and the app verifier must
reject the changed request. Source/type conflicts return an explicit error.

## Compatibility checks before switching

Keep kits/groups and lines requiring explicit bin/lot/serial allocations on the
existing path. This version rejects them before save; it does not claim native
REST/SuiteScript parity for those cases. Custom fields, hidden line fields and
native/user-event behavior must be proved in the target sandbox. Missing charge
rates/amounts remain unavailable evidence and must fail the app verifier.

Prove each enabled transform using ordinary and partial quantities, omitted
lines, noninventory items, purchase charges, location splits, TO partial
fulfillments/receipts, the account's mandatory custom fields, repeating the same
external ID and concurrent retries. Compare the saved record to this response
and check the existing IF/IR webhook still fires under the RESTlet execution
context. Preserve the old flow until these checks and the app integration pass.

## Reproducing local checks

Run from the repository root with the standard test image available:

```sh
bash server/tools/ifir-posting-restlet-checks.sh
```

If that image needs building, use the repository's normal isolated test image
build procedure. The runner also accepts `IFIR_TEST_IMAGE` and
`IFIR_TEST_NODE_MODULES` to reuse an existing Node image/toolchain without an
installation. Its source is mounted read-only, it uses `mbbs-tests.slice` and
the standard Compose limits, and it tears down its own project, volumes and
network on exit. Logs and the evidence report remain in the artifact directory.
