# NetSuite IF/IR Reconciliation Webhook

`netsuite-ifir-reconciliation-webhook-user-event.js` is a standalone,
optional webhook for PO/TO reconciliation. It does not replace or modify the
existing Sales Order, Purchase Order, and Transfer Order webhook.

Deploy it on:

- Item Fulfillment — Transfer Order fulfillments are sent.
- Item Receipt — Purchase Order and Transfer Order receipts are sent.

Known fulfillments/receipts created from unrelated transaction types are
ignored. If NetSuite cannot identify the source type, the event is sent so the
application can retain and review it rather than lose evidence.

## Configuration

1. Generate one long random shared secret.
2. Store the value in the application configuration and in NetSuite at
   **Setup > Company > API Secrets**. Give the NetSuite secret a script ID such
   as `custsecret_mbbs_ifir_webhook_hmac` and allow the new User Event script to
   use it.
3. Upload `netsuite-ifir-reconciliation-webhook-user-event.js` and create a
   SuiteScript 2.1 User Event script, for example with script ID
   `customscript_mbbs_ifir_reconcile_wh`.
4. Add these two Free-Form Text script parameters:

   | Parameter ID | Value |
   | --- | --- |
   | `custscriptmbbs_ifir_webhook_url` | `https://your-server.example/api/webhooks/netsuite/if-ir` |
   | `custscriptmbbs_ifir_hmac_secret` | The API Secret **script ID**, for example `custsecret_mbbs_ifir_webhook_hmac` |

5. Create separate deployments for **Item Fulfillment** and **Item Receipt**.
   The execution role needs permission to read the created-from PO/TO and its
   item lines.

Do not put the secret value in a script parameter or in this source file. The
parameter contains only the NetSuite API Secret script ID.

## Authentication

Each request includes:

```text
x-mbbs-ifir-event-id: <UUID>
x-mbbs-ifir-timestamp: <Unix epoch seconds>
x-mbbs-ifir-signature-version: v1
x-mbbs-ifir-signature: sha256=<lowercase hex digest>
```

The HMAC-SHA256 input is the exact UTF-8 string:

```text
<timestamp>\n<event-id>\n<raw-request-body>
```

The receiver must verify the signature against the unmodified raw JSON body,
reject stale timestamps, and deduplicate accepted event IDs.

## Payload

The schema version is `mbbs.ifir.reconciliation.v1`. Create and edit events
contain the current saved record. Delete events contain a tombstone and the
complete `context.oldRecord` snapshot.

```json
{
  "schemaVersion": "mbbs.ifir.reconciliation.v1",
  "eventId": "b8657d0d-0fb3-49cc-b602-0a0d8a776b44",
  "eventTime": "2026-07-29T21:30:00.000Z",
  "eventTimeEpochMs": 1785360600000,
  "action": "edit",
  "sourceEventType": "ship",
  "executionContext": "USERINTERFACE",
  "tombstone": null,
  "record": {
    "internalId": "12345",
    "recordType": "itemfulfillment",
    "transactionRef": "IF12345",
    "status": {
      "value": "C",
      "text": "Shipped",
      "shipStatus": { "value": "C", "text": "Shipped" }
    },
    "createdFrom": {
      "internalId": "9876",
      "reference": "TOB00749",
      "recordType": "transferorder",
      "locations": {
        "source": { "internalId": "1", "name": "12441" },
        "destination": { "internalId": "2", "name": "3445" }
      }
    },
    "locations": {
      "actual": { "internalId": "1", "name": "12441" },
      "lines": [{ "internalId": "1", "name": "12441" }]
    },
    "deleted": false,
    "lines": [
      {
        "lineUniqueKey": "445566",
        "orderLine": "1",
        "sourceLineId": "1",
        "sourceLineKey": "112233",
        "sourceLineUniqueKey": "112233",
        "itemId": "321",
        "itemName": "ITEM-321",
        "quantity": 10,
        "unitId": "1",
        "unit": "EA",
        "location": { "internalId": "1", "name": "12441" },
        "isIncluded": true,
        "reconciliationRelevant": true
      }
    ]
  }
}
```

For inline edits, packing, and shipping events, the script reloads the saved
IF/IR so it sends a complete snapshot. For deletion it cannot reload the
record, so it serializes `context.oldRecord` after the delete succeeds.

## Failure behavior

The HTTPS call runs from `afterSubmit`. A missing parameter, source lookup
problem, timeout, non-2xx response, signing problem, or other delivery failure
is written as a NetSuite `log.error` entry with the event and transaction
identifiers. The script catches the failure and does not throw, so it never
reverses or blocks the saved IF/IR.

Because delivery is synchronous, an unreachable endpoint can add NetSuite's
HTTPS timeout to the save operation. Nightly and manual reconciliation must
remain authoritative and recover missing webhook events; the application must
operate normally when this script is undeployed or the endpoint is offline.
