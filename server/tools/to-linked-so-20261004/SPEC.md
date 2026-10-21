# Linked SO completion for TO posting

Tier 3: this gate controls financial/inventory posting. Spec approval: not obtained (autonomous run); the user authorized the fix and requires checking existing IF/IR before retries.

Failure model: posting on the wrong SO, group member, plan or load; reusing withdrawn completion; changing a link after Operator loading; duplicate IF after manual fulfillment; changing loaded quantities; local loading blocked by missing NetSuite/dispatch evidence; stale/misleading queue text. Address these with real repository integration tests, scoped immutable evidence, adversarial/property tests, mutation, live read-only verification and a transactional repair rehearsal.

Acceptance criteria, stated before implementation:

1. A direct-to-customer TO captures its explicit active dependency and the real SO references, including allocated SO members of a group. It retains the exact planned plan/load/date and the Operator quantities. Date objects must serialize as YYYY-MM-DD, never `Sat Oct 03`.
2. The matching SO Driver drop-off plus an Operator record admits the TO. A group with two linked SOs requires effective completion for both. An unrelated SO, pickup, wrong plan/load/date, incomplete or withdrawn Driver record cannot admit it. Normal TO drop-off behavior and Operator-first/Driver-first completion remain supported.
3. A cancelled or changed dependency, an ambiguous assignment, or incomplete linked scope blocks backend posting with actionable Admin attention. Local Operator loading still succeeds. The originally captured source identity and quantities cannot be replaced by live planning data.
4. Before a queued command posts, all linked Driver completion identities and the original dependency scope remain effective. Existing retries keep their original external ID; no duplicate transform is allowed after an uncertain result.
5. Admin verification attention displays the linked SO numbers and the group reference where applicable. A waiting job says which SO delivery it awaits. Text is rendered safely as text, and ordinary TO queue rendering remains intact.
6. TOB01190 and TOB01191 must first be checked in NetSuite. Existing IF156515 and IF156516 may be attached only after exact source/physical-line/item/quantity/location checks and live Operator + linked-SO Driver evidence. No new IF/IR will be posted for this reconciliation. Refresh verified cached status and audit original job state; never record another physical load or receive.

Setup: reuse existing isolated Node/Postgres/browser tools; no dependencies, migrations, git commits or unrelated repairs. Save tests, reproducible tools and evidence under this task's directory. Capture runtime baseline and deploy only reviewed files over the currently running image, with image/source guards and rollback retained. Broader suite/type failures already exist; record zero-new-failure comparisons and explicit limitations.

Investigation: TOB01190 links to SOA09690. TOB01191 links to SOA09694 and SOA09702 through GOA-9694-9702. Both Driver deliveries are complete. The old worker only accepted `order_kind='TO'` / `driver_job`, ignoring SO evidence; both old snapshots also contain an invalid date string. Existing NetSuite IFs are verified before local cleanup and will not be replayed.

Adversarial refinement: cancelling the linked dispatch plan must also invalidate readiness, even if the old dependency and Driver rows remain. A missing linked plan/load/date must remain an Admin problem while the local Operator record is retained.

Existing-IF reconciliation refinement: a verified job completed without an app-created command must remain terminal if a scheduler already selected it before reconciliation. Preparation must return completed jobs without reads, admission or mutation.

Stale-record refinement: the current Driver record must still contain the completed SO and the event's plan date. Historical completion events retained after editing the Driver reference/date cannot authorize a TO.

Final reconciliation boundary: an Admin retry from a stale, already-open queue card must also leave a reconciled existing-IF job completed. Test persisted state, since the old retry method returned the old job even after resetting its database status.
