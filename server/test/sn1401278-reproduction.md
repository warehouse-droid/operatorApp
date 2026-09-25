# SN1401278: IR missing and screen returns to Receiving

The operator reported that the IR number never appeared and the screen returned
to Receiving. The user clarified that the operator searched the PO directly.

The symptom is reproducible with direct PO search **when an older Operator
screen is automatically reloaded during receipt posting**. The same flow on
the currently deployed screen restores the receipt and displays **IR14813**.
The incident's actual client version and reload are unconfirmed; the reproduction
does not establish that the operator encountered this particular trigger.

## Production evidence

Read-only PostgreSQL queries found:

| Field | Recorded value |
| --- | --- |
| Receiving reference | SN1401278 |
| Local order ID | -185021706058979 |
| Source PO | POB03658 / 936958 |
| Yard | 3445 / location 1 |
| Receipt | IR14813 / 1013762 |
| Posting command | ee1aa1bb-8673-40d6-a807-1ddfa768588a |
| Submission | September 24, 2026, 23:03:46.394 UTC |
| Completion | September 24, 2026, 23:04:00.229 UTC |
| Duration | 13.835 seconds |
| Outcome | Command completed, receipt step posted, no saved error |
| Attempts / local receipt records | 1 / 1 |

The completed response contains `localFinalization.itemReceiptTranid: IR14813`.
The audit records page confirmation at 23:03:32 UTC and two background-photo
uploads at 23:03:54 and 23:03:55 UTC. Those requests identify Android Chrome
153. The retained audit entries contain no client navigation or asset version.

Evidence: [incident snapshot](../test-artifacts/sn1401278-reproduction/incident.json)
and [audit timeline](../test-artifacts/sn1401278-reproduction/audit.json).

## Direct-search reproduction

1. Load the archived Operator script from before the September 23 receipt-status
   release, representing an already-open older app screen.
2. Start at Receiving with the Purchase Order default. Directly search
   `SN1401278` and press Enter.
3. Tap **Confirm page**, then **Receive**, provide two test photos, and tap
   **Receive** once.
4. While the receipt job is posting, simulate the service worker
   `controllerchange` event. The deployed event handler reloads the page.
   Serve the current assets after this reload and return the existing completed
   receipt result from the mocked server.
5. Observe **Receiving**, an empty search result, and no IR number. No Back or
   completion-acknowledgement button was pressed, and only one simulated receipt
   submission occurred.

The older screen keeps the active receipt only in memory and writes no receipt
recovery journal. Its saved module is `receiving`. After reload, the new screen
has no saved request to recover. The completed order is absent from the open
receiving list, so its IR confirmation is never displayed.

[Direct-search failure screenshot](../test-artifacts/sn1401278-reproduction/browser/direct-mobile-legacy-app-update-after.png)
and [browser trace](../test-artifacts/sn1401278-reproduction/browser/direct-mobile-legacy-app-update-trace.zip).

## Controls and separate finding

| Scenario | Result |
| --- | --- |
| Current screen, direct PO search, mobile touch, 13.835-second posting | IR14813 remains visible |
| Current screen, direct search, lost submission response | Recovers IR14813 |
| Current screen, direct search, automatic app reload during posting | Recovers IR14813 |
| Older screen, direct search, normal completion | IR14813 remains visible |
| Older screen, direct search, automatic app reload during posting | **Returns to Receiving; IR missing** |
| Current screen, Purchase Order search and manual reload | Recovers IR14813 |
| Current screen, normal receipt completion and background order events | IR14813 remains visible |
| Current screen, PO search from Transfer Order menu, normal completion | IR14813 remains visible |
| Current screen, PO search from Transfer Order menu, manual or automatic reload | **Returns to Receiving; IR missing** |
| Current screen, PO search from Transit CO menu, manual reload | **Returns to Receiving; IR missing** |

The separate current-version failure restores the receipt journal using the
menu's `receivingOrderType` instead of the selected order's actual type. Its
purchase-order journal still exists, but recovery looks under `transfer_order`
or `co_order`. The user's clarification does not establish this menu mismatch
as the incident's cause.

Relevant current code: `restorableModule`, `restoreOperatorView`,
`receiptPostingJournalKey`, `resumeReceiptPosting`, and the service-worker
`controllerchange` handler in `public/operator.js`.

[Current direct-search success](../test-artifacts/sn1401278-reproduction/browser/direct-mobile-normal-after.png),
[direct-search results](../test-artifacts/sn1401278-reproduction/browser/direct-results.json),
and [initial seven scenarios](../test-artifacts/sn1401278-reproduction/browser/results.json).

## Replay and limits

The [reproducer](../tools/sn1401278-reproduce.mjs) runs Chromium 151 with all
browser requests intercepted inside a container with networking disabled.
It reconstructs the pre-receipt view from the saved order lines, uses test photos
and a test account, and returns the captured completed job result. The mobile
cases use a 412 x 915 viewport and touch taps. The older-client case substitutes
the captured legacy `operator.js` on initial load; other assets are current.
The automatic-update event is simulated. The physical operator device and its
cached assets were not inspected.

Captured current `operator.js` SHA-256:
`3f1015126c4b910dfa340178a3f1ac201673253f2f61f092c62a63603a5f11d6`.

Archived pre-release `operator.js` SHA-256:
`4876c753095debca2aa01f7dd4e0c74c287461321a83d208a0472ba4bc9feda1`.
This matches the baseline manifest of the September 23 receipt-status release.

From the repository root, replay the five direct-search scenarios with:

```sh
docker run --rm --network none --read-only --tmpfs /tmp:mode=1777 \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e SN1401278_DIRECT_ONLY=1 \
  -v "$PWD/server/tools/sn1401278-reproduce.mjs:/app/tools/sn1401278-reproduce.mjs:ro" \
  -v "$PWD/server/test-artifacts/sn1401278-reproduction:/app/test-artifacts/sn1401278-reproduction:rw" \
  --entrypoint node field-sales-check-2941306:latest \
  /app/tools/sn1401278-reproduce.mjs
```

Omit `SN1401278_DIRECT_ONLY` to run all twelve scenarios. Results include source
hashes, browser state before and after, request counts, screenshots, and traces.
Production access for this investigation consisted of reads. Application code,
receipts, and deployment were not changed.
