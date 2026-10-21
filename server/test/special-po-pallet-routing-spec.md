# Special PO PALLET review and routing

Spec approval: not obtained (autonomous run under the user's requested fix).
Tier 3: purchasing payload and persisted order coverage.

Acceptance scenarios:

1. SCM reviews PALLET quantity 2 EACH and purchase cost 35 independently of
   the SO's selling rate 40. Preparation persists one ancillary purchase line.
   Repeating preparation replaces it; zero removes it. SO lines stay unchanged.
2. Positive PALLET quantity requires a reviewed non-negative cost. Blank,
   fractional, negative, infinite, boolean, and excessive quantities fail.
   Requests predating the field may omit it only when the SO has zero pallets.
   A failed preparation rolls back material and pallet edits together.
3. The PO payload contains the PALLET once, at the reviewed quantity/cost/UOM,
   while the summed vendor discount applies only to reviewed materials.
   Recovery reuses stored lines and never resubmits an uncertain PO.
4. After PO creation, the request shows the PO Split routing and notes rows:
   method, manual status, vendor pickup yard, Sp.O, packing slip/reference,
   destination override, remark, and Save Schedule. The existing PO Split
   page remains available for quantity splitting.
5. Routing reads the selected PO's authoritative catalog record, writes the
   existing schedule API with its revision, and reloads the saved record.
   Case switching cannot accept a stale load. Failed saves retain the draft.
   Closed requests, adjustment reviews, and locked splits cannot be edited.
6. SPREQ-000017's existing PALLET is matched to its synced PO identity,
   description, quantity and purchase rate, then audited and reconciled.
   This repair must not create a PO or change either NetSuite order.

Failure model: missing/duplicate PALLET (repository and payload tests),
wrong sale/purchase rate or discount total (properties and boundary tests),
partial writes (transaction rollback), duplicate remote order (existing
standalone recovery tests), stale routing overwrite (revision contract and
browser tests), cross-case load (browser test), XSS (escaped HTML test),
incorrect live repair (guarded transaction and before/after evidence).

Setup: use existing isolated PostgreSQL, Node, Playwright, TypeScript,
ESLint, c8 and fast-check tools. No new dependencies or schema migration.
Add feature tests, a reproducible check/deployment entry point and evidence.
Capture existing dirty workspace files; publish only this feature's patch
over captured running sources with an image rollback available. No commits
or unrelated workspace changes are authorized by this setup.

Amendment from the first GREEN run: the existing order-line check constraint
permits ancillary lines only on SOs. Add a narrow migration permitting PO
ancillary rows only for PALLET (item 1784), with a unique PO PALLET index.
Rehearse application and rollback in isolated transactions before deploying.
All original SO and material-line rules remain in force. The earlier setup
statement that no migration was needed is superseded by this finding.
