# Dispatch search fix acceptance criteria

Authorized by the user's request to perform the fix after the recorded browser
and live database reproduction. Evidence-first tier 3: concurrent reads and plan
edits can otherwise lose search results or overwrite operational data. Separate
spec approval was not obtained (autonomous run); the user authorized the fix.

1. TOB0126 returns and renders all ten fixture references after an unrelated
   order update, a local plan edit, or a targeted order mutation during its read.
2. Existing queued refresh work serves the current search, instead of the SO
   browse tab. No new polling timer, retry loop or extra parallel refresh is added.
3. A newer targeted read or mutation, local planning state and structural
   retirements survive an older search response. Group hydration remains safe.
4. A superseded search, changed plan/date, or navigation away and back cannot
   apply an old response or clear a newer search's loading state. Genuine request
   failures show an error; an empty successful result completes normally.
5. The backend preserves exact returned order data and existing search/eligibility
   rules, including older orders, completed search-only cards, PO/TO receiving
   lines, source/split/group references, inactive lines, quantity allocations,
   and historical lease checks. Do not use the bounded browse catalog for search.
6. Remove the observed repeated full receiving-line scan from the search query.
   Compare live read-only TOB0126 results and latency before/after; target at least
   a threefold improvement from the reproduced 23.5–24.6 second search.
7. Deploy only the verified delta over the current live image; preserve application
   configuration and dependency containers. Verify health, served assets and the
   actual search; automatically roll back an unsuccessful application deployment.
8. All test workloads use the existing bounded Compose/disposable runner and
   unconditional teardown, including failures. Remove raw test artifacts and
   owned containers, volumes and networks. Retain concise evidence and rollback
   audit data only.

Tools: existing Node test runner, Playwright, Espree, fast-check, ESLint,
TypeScript and c8 in disposable test images. No application dependency changes,
new global settings, database migration, Git commit or production order edits.
Files added are scoped regression/browser tests, reproducible check/release tools
and evidence. Capture workspace and live baselines before implementation so
unrelated dirty workspace changes never enter the release.

Failure model: dropped reads (browser race cases); stale overwrite/retirement
resurrection (adversarial browser and unit cases); changed eligibility or quantities
(database parity and integration regressions); query-plan regression (EXPLAIN
and live timing); stale deployment baseline (image/hash guards and rollback).
