# One-time Transfer Order cleanup — 2026-09-15

User-authorized scope: repeat the SO cleanup for TOs, including Receiving. Apply after a dry run and isolated rehearsal; skip records requiring review.

## Executable acceptance rules

- A current NetSuite Transfer Order status F (Pending Receipt) or G (Received), with an exact ID/reference match, proves outbound fulfillment. Active, durable TO splits may inherit this proof from their registered source; cancelled or unregistered splits cannot.
- Driver-completed dropoffs and recorded direct deliveries qualify directly for Loaded. This path does not change cached NetSuite status or fulfillment fields.
- Receiving becomes Received only with current NetSuite G/Received evidence or an existing successful local receipt. Driver delivery alone and F/Pending Receipt do not prove receipt. The user explicitly confirmed this rule during the cleanup.
- NetSuite Received proof updates the receiving baseline to the full required quantity, clearing stale unposted Receiving selections. It never posts an Item Receipt or changes receipt IDs, receipt times, photos or physical receipt history.
- Outbound updates use Operator's actual pickable-line and sales-unit rules. The composite transfer-line key includes `line_stage`; receiving updates cannot overwrite outbound quantities and vice versa.
- Skip ambiguous identities, held/cancelled/review orders, inactive split definitions, missing NetSuite records, work being prepared/posted, and unsafe quantities/units. Preserve inactive/service lines and commercial quantities.
- NetSuite-only completed transfers remain Complete in Dispatch and can be planned. Current Driver/manual/direct completion blocks planning, including stale or forged client flags. Existing Hold/cancelled/review/method/lifecycle restrictions remain effective.
- TO-linked COs (including recorded grouped members) must all have verified completed sources before becoming Loaded. Preserve their cargo, receipt state and source membership.
- Apply only an explicitly hashed manifest with fresh proof. Lock, revalidate before-images and evidence, update atomically, assert protected records unchanged, and prove an immediate repeat has zero changes.

## Validation

Run a meaningful failing Dispatch test on the deployed baseline, then test status distinctions, both transfer-line stages, local completion, receipt preservation, split isolation, stale manifests, rollback and repeat application. Rehearse actual candidate before-images in an isolated database. Verify Dispatch planning through HTTP and Driver job creation, plus Operator Delivery and Receiving projections. Check today's live plans read-only after application.

Current deployed baseline at preparation: `mbbs-operator-app:dispatch-split-address-20260915-v1`. Scope deployment to task changes layered on the latest live image; preserve concurrent work.

NetSuite status semantics: [Fulfilling Transfer Orders](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2312176.html), [Receiving Fulfilled Transfer Orders](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2312912.html).
