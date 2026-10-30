# Backorder Sales internal note — 2026-10-28

The saved Sales internal note was only rendered inside the collapsed header
editor. It now appears in the Sales progress view for active and completed
Backorders, with line breaks preserved and text escaped. Empty notes add no
section. Existing editing and Sales-only API visibility remain unchanged.

The three-asset release includes Sales cache-key updates. No server or schema
changes were required. All **29 existing browser, integration and review-flow
checks passed** with added assertions for visible saved notes, editing/reload,
plain-text rendering, completed requests and SCM exclusion.

Tests used the bounded disposable Compose runner under `mbbs-tests.slice` and
the retention runner's unique artifact directory. Teardown removed task test
containers, database storage, networks and generated browser/log artifacts.

Deployed as `mbbs-operator-app:backorder-sales-note-20261028`. All three assets
matched through local and public HTTP checks; application health passed, and
configuration and the other production services were preserved. Release and
rollback audit records are in `server/deployments/backorder-sales-note-20261028`.
