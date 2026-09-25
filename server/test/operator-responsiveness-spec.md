# Operator pickup and Packed-list responsiveness

Spec approval: not obtained (autonomous authorized bug fix); use existing evidence-first workflow. No dependencies, migrations, NetSuite writes or commits added.

1. Once packing is confirmed by the server, Packed displays that order without waiting for the full list, including when the initial Packed prefetch is still pending or the cached list belongs to another yard. Never expose another yard's cached orders.
2. Old list requests cannot remove the newly packed order. Failed pack requests do not move orders into Packed. Partial packing stays available in Active as appropriate.
3. Customer pickup posting checks the job immediately and wakes promptly on its own completion event. Events are hints only: success still requires the authorized job endpoint to report completion. Unrelated events do not cause reads, missed SSE keeps a one-second fallback, no overlapping job reads, listeners/timers cleaned on success/failure.
4. Do not weaken NetSuite source validation, duplicate protection, photo durability, transaction verification, or SOR pause. Read existing live timings; use isolated Playwright and delayed/reordered transport responses for behavioral reproduction. Test the exact scoped live-source candidate before deployment.

Failure model: cold/stale cache membership (browser regression with held responses), wrong-yard exposure (scope-switch test), stale response overwrite (existing race suite), early success/duplicate posts (job-state tests), event timing race (in-flight wake test), PWA cache mismatch (versioned asset checks).

Asset acceptance update: both the Operator client and its refresh helper are pinned to `20260924-operator-responsiveness-v1` in the HTML and service-worker cache. Update the existing release-specific version assertion to this exact value; keep its precache and ordering assertions intact. The original assertion is already stale on the captured live image (it still expects the September 22 release).
# Additional observed error path

The real-browser failed POST case exposed an async click handler that returned the packing promise without awaiting it, bypassing the surrounding error toast. A rejected Mark Packed request must show its server error and must leave the order out of Packed. Keep this failing test before adding the await.
