# Backorder PO routing acceptance — 2026-10-29

Spec approval: not obtained (autonomous run). Tier 3 for the order-linking and
HTTP authorization boundary. No new dependencies, schema changes or commits.
Apply only this task's diff to the captured live runtime; preserve other work.

1. An SCM Backorder with a linked PO shows the shared SCM mini-panel and a
   dropdown of active children of that PO. Sales has no routing editor.
2. Selecting a child persists its identity and shows its reference and routing.
   Selecting Whole PO detaches an editable child. Native PDF identity remains
   the parent. Parent and sibling rows do not change when editing a child.
3. The existing case revision, split revision, active-child, received, allocated,
   planned and terminal-case guards apply. Competing attachments produce one
   success and one conflict. Foreign, malformed and cancelled children fail
   without changing the request revision.
4. SCM read/write permissions and the Backorder workflow boundary apply to all
   new endpoints. Special requests retain their existing behavior.
5. Failed routing saves keep entered values; retry reloads the selected PO.
   A late response for another request cannot replace the current panel.
6. STREQ-000166 remains linked to POB04147 until a child is explicitly selected;
   its existing children SN1403563 and SN1403624 are already planned and must
   retain their routing, references, plans and lock protections.
7. Refresh reloads the selected PO's routing even when the request revision has
   not changed. Whole-PO notes resolve the vendor from the linked PO, since a
   Backorder may carry different vendors on individual materials.

Failure model: wrong child/source writes (exact database comparisons), stale
attachment or routing (HTTP replay and concurrent save), wrong role/workflow
(HTTP denial tests), stale browser responses (browser switch regression), and
changed Special behavior (existing suites). External NetSuite behavior is
covered at the existing boundary, with no test writes to NetSuite.

Verification uses the standard bounded Compose services in mbbs-tests.slice,
wrapped by retention cleanup. The task runner registers teardown before
creating containers and removes all test storage and output. Run the affected
Backorder/Special suites, focused types/lint, coverage, plausible mutations,
property cases and a real browser against the disposable HTTP application.
