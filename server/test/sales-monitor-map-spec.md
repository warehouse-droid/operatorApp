# Sales Truck Monitor map access

Tier 3 because the fix touches an authorization gate. Spec approval: not obtained (autonomous run). The reported symptom is a map being off in Sales. Code inspection shows that signed-in Sales can read the monitor/config, but its POST browser-map admission is rejected by the Dispatch gate. Live settings have maps enabled in normal mode and public Sales disabled.

1. A signed-in Sales user can POST exactly `/api/dispatch/maps/browser-session`; when maps are configured and budget admits it, HTTP 200 returns the dedicated browser key and records normal usage. The real Sales monitor page can construct its map and truck markers through this endpoint.
2. Sales keeps its existing GET access. Other Dispatch POST/PUT/PATCH/DELETE commands, route estimation, monitor ETA, SCM paths and similar-looking map URLs remain forbidden. Dispatcher/Admin behavior is preserved. Other staff roles and anonymous/public-header requests do not gain map admission.
3. Admission still obeys disabled/conserve/normal policy, hard usage limits and browser-key configuration. Do not expose the server key, alter budgets, enable public Sales, or bypass the existing metering handler.
4. Automatic monitor refresh reuses the map without additional admission calls. The existing display/layout is unchanged.

Failure model: accidentally broad Sales mutation authority (HTTP matrix, hostile URL/property matrix, mutations); loss of map admission (RED HTTP/browser reproduction); budget bypass (real ledger/policy checks); deployment replacing unrelated work (patch against current live image and source hashes, rollback image); billing external Google during verification (fake Google script at the network boundary, no production map-admission write).

Setup: reuse installed Node/PostgreSQL/Playwright/fast-check/c8/ESLint/TypeScript tools, no new dependencies or commits. Preserve the dirty worktree and capture the starting server source. Add focused tests, persisted verification tools and an evidence report. Compare the full regression run against the recorded existing failures. Deploy only the minimal server patch under the existing deployment authorization. No live credentials or requests are created for testing.

Verification clarification: the existing usage repository hashes actor IDs with SHA-256. The first HTTP test incorrectly expected a raw actor ID after the map fix succeeded. Assert the exact existing hash instead; retain this privacy behavior and make no implementation change to the ledger.
