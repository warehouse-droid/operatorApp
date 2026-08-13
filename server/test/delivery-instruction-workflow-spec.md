# Delivery Instruction Workflow — Executable Specification

Approved source: the user-approved implementation plan in the conversation.

## Automatic memo content

- A Sales Order reads its raw instruction source from NetSuite `transaction.custbody7`, mirrored as `sales_orders.memo`.
- An unambiguous address/date/time line is omitted from the Driver instruction text.
- Telephone, contact, placement, account, access, and otherwise unclassified lines are retained.
- A mixed or incompletely classified memo falls back to the complete raw memo; content must never silently disappear.
- Telephone values are exposed as safe `tel:` links.

## Editing and media

- Sales and Dispatch share one additional-text value and the same gallery. Replacement uploads keep the original gallery position and retain the old file unless the new registration commits.
- Mutations require the current revision; a stale revision returns conflict without changing text or media.
- A Driver-completed Sales Order drop-off is read-only; reopening it makes it editable again.
- Each Sales Order permits at most five active JPEG/PNG/WebP/HEIC/HEIF/MP4/MOV/WebM objects, each at most 25 MiB.
- Media is uploaded unchanged, registered only under its issued upload identity, and soft-deleted with audit identity.
- Issuing an upload reserves one of the five slots. Its additive registration remains valid after an unrelated text edit, without overwriting that text; exact registration retries are idempotent.
- Sales access is limited to authorized ordering yards. Dispatcher/Admin access is global. Drivers can read media only for an assigned Sales Order drop-off.

## Surfaces

- Staff Sales has `/sales/delivery-instructions`, with server-side SO search and completed history shown read-only.
- The Dispatch SO edit modal lazy-loads the same editor without committing a dispatch-plan mutation.
- Driver drop-offs with at least one SO have one combined instruction page first, followed by the existing five-item pages. A blank instruction page explicitly says there are no instructions.
- Pickup, travel, PO, TO, CO, and BIN behavior is unchanged.
- Instruction changes alter the Driver content fingerprint but never immutable job/completion identity.
- A live instruction event patches only the current stop-detail page, preserves scroll, and refreshes the saved offline day plan without rerendering the route screen.

## Offline and compatibility

- Text and metadata are stored in the Driver manifest.
- Images use a separate 250 MiB per-driver route cache, current/next stop first. Video remains online-only.
- Instruction-media cache failures never block Driver start/complete actions or consume the evidence-photo budget.
- Existing application dependencies are reused; no new package is authorized or required.
- Every media response is authenticated and authorized before lookup/streaming, uses the stored MIME type, disables sniffing and shared caching, and supports bounded byte ranges for video.
