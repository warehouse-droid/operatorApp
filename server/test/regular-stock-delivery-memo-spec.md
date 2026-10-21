# Delivery TO memo

Spec approval: not obtained (autonomous run). Tier 2 small follow-up to the existing verified workflow.

- A newly created simplified regular Delivery TO has memo equal to the canonical Sales Order number, with no prefix or suffix.
- A retry after a remote TO creation response is lost recovers by the existing unique request/transfer external ID; one TO and one print job result.
- Recovery also finds previously created TOs bearing the old memo marker. Duplicate or route-mismatched matches remain rejected.
- Pickup, Stocking and legacy stock requests retain their existing memo and routing behavior.
- No historical TO edits or live test orders/printing. No schema or dependency changes.

Failure model: removing the memo marker can lose recovery identity and duplicate TOs; exercise actual HTTP adapters with a lost creation response and strict remote lookup matching. Reading the wrong SO reference can mislabel a TO; assert canonical saved reference through real repository and HTTP submission. Route/quantity/approval/print regressions are guarded by the complete existing regular-stock suite.

Setup: reuse existing isolated Docker Node20 and disposable Postgres18 tooling; no package installation or git commits. Add focused tests, check/deploy scripts and evidence artifacts named regular-stock-delivery-memo. Deploy only the three changed runtime files over the current test image after checks, preserving dependencies and configuration with rollback available.
