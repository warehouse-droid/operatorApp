# NetSuite webhook orderLine update

The application now accepts and stores `lines[].orderLine` separately from
`lineUniqueKey`. It uses the actual NetSuite item sublist `line` field; it does
not derive it from the row position or unique key.

## Update the existing File Cabinet script

- Direct User Event setup: replace `netsuite-order-webhook-user-event-direct.js`.
- Queued setup: replace `netsuite-order-webhook-scheduled.js`.
  The queue-only User Event script requires no change.

Keep the existing script records, deployments, parameters, URLs, secrets,
audiences, and context filters. Updating the script file attached to the existing
deployment is sufficient; do not create duplicate deployments.

After the next ordinary SO, PO, or TO edit, verify that its webhook lines include
`orderLine` and that the corresponding application line has
`netsuite_order_line` populated. A missing source value is sent as null and does
not erase a previously observed mapping. No transaction posting is needed for
this verification.

Both sender entry points were exercised in the SuiteScript VM harness. This
package is prepared for installation; deploying the application does not update
NetSuite's File Cabinet.
