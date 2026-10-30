# Special request child PO attachment

Spec approval: not obtained (autonomous run under the requested fix). Tier 3:
the principal risks are changing sibling routing, associating the wrong split,
stale concurrent saves, and sending synthetic IDs or shared changes to NetSuite.

Acceptance criteria:

1. A linked special request can select an active child of its source PO in
   the PO split and routing section. Persist its exact split identity and
   revision-check attachment changes. Reject another parent's child, cancelled
   children, stale requests, and replacing a target after operational work.
2. Selected-child routing, local notes, request remarks, planning, handoff and
   completion use that child. Sibling and source order/schedule records remain
   unchanged. Retain the source NetSuite PO identity for approval and PDF preview.
3. Child routing saves enforce schedule and split revisions and existing locks.
   They never write a shared source NetSuite Note. Unsplitting an attached child
   is rejected until the request is detached.
4. Existing manually linked POs can preview their native PDF without locally
   drafted lines. Missing/skipped orders and unauthorized audiences stay blocked.
5. Schedule content displays the special item's description and exact remaining
   quantity, including 1771.2 SQFT plus 18 EACH for an L3-style child. Parent
   residuals and sibling quantities remain independent.
6. Exercise the rendered selector/save flow, database rollback/error paths,
   and current parent-only routing/document behavior in disposable containers.

Setup: use existing Node tests, Playwright, ESLint, TypeScript and c8. Add no
dependencies and make no commits. Stage task-only changes over captured live
source for deployment; retain rollback image and concise audit evidence.
Register teardown before tests, use standard bounded Compose services and the
retention wrapper, and remove all disposable containers, volumes and artifacts.

Observation: live schedule reads already return L3-18Plt quantities. A persistent
empty API value was not reproduced; product descriptions and fractional display
are missing from the current content projection and will receive regression tests.

Additional acceptance criterion from the routing/reference check: saving child
routing must preserve the child's dispatch reference. Show its reference read-only
in the request and reject the native-PO reference editor for an attached child;
renaming stays in PO Split, which updates split identity and schedule references
together. The first browser alert check exposed the reference being cleared by
the generic native-PO editor when it equalled the child's original number.

Live verification found L4 already allocated to the request's own SO (SOB123598).
Refine the operational-work guard: the first child attachment may preserve an
existing allocation when every allocation on that selected child belongs to the
request's exact native SO. Keep rejecting other-SO allocations, replacing an
already attached allocation target, receiving/driver work and existing planning.
Attachment must leave allocation rows and parent/sibling orders unchanged.
