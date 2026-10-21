# Pickup lookup access: SOA10099 / SOA10159

The old lookup checked the whole sales order against the operator's yards. A
regular 3445 operator was denied because a second inventory line belonged to
2967; the frontend handled that 403 by clearing the workspace and returning to
yard selection. The previously deployed line-scoping release already fixes this
lookup. This follow-up adds real-browser regression coverage and verifies that
release; it makes **zero runtime changes** and does not redeploy the app.

Qin's live grants are [1, 15] (3445 / 12441), and both orders were placed in 2967.
Live read-only verification at 2026-10-10T20:12:42.303Z allows only line 531490 of
SOA10099 and line 532526 of SOA10159 when Qin selects 3445. Qin's latest session
activity is 2026-10-10T19:43:02.027Z, before the line-scoping deployment at
2026-10-10T19:50:53.032079Z. The operator should refresh the app and select 3445
before retrying.

Spec approval: not obtained (autonomous run). Scope is the append-only
`customer-pickup-lookup-access-spec.md` and the prior deployed pickup fix.

| Criterion | Verification | Result |
| --- | --- | --- |
| L1 regular account with Qin's grants opens each mixed-yard pickup using Enter or Find Order | `customer-pickup-lookup-access.browser.test.mjs`, real browser and HTTP/DB | Four lookup cases pass; current screen stays in pickup at 3445 |
| L2 only 3445 line is visible and both drafts are preserved | Same browser cases, response/DOM and before/after DB assertions | Pass |
| L3 other-yard lookup and forged foreign-line mutation stay denied | Fifth browser-suite test with actual authenticated HTTP boundary | 403 for both orders, drafts unchanged |
| L4 historical failure and current deployed state | Historical browser execution plus `customer-pickup-lookup-access-live.mjs` | All four historical lookup cases return 403 and visibly reset to yard selection; current cases return 200 |

Fresh final checks at 2026-10-10T20:12:37.329Z: **37 tests, 37 passed, 0 failed**.
This includes the five real-browser/HTTP cases and existing pickup scope,
confirmation, clearing, load finalization and frontend request tests. The scope
property runs 60 seeded cases. Three new JavaScript files pass syntax checking;
strict lint reports no errors or warnings. The same 37 cases passed in an earlier
current-source run, as well as this final run after the diagnostic refinement.

Historical RED is expected: four lookup failures and one permission-isolation
pass. An initial replay exposed a diagnostic race: the old automatic page reload
discarded Chromium's response body. The diagnostic now records status and the
observed yard reset for failed responses. Expected lookup status 200 and all
other behavioral assertions were preserved.

The release check verifies all 12 deployed source hashes against the tested
manifest, all three served operator assets locally and publicly, and local/public
health 200. Current image:
`sha256:91d91242c0c571abffbacd120d1faa896419b95d2e2db4de6fa0d13e1b1d3d0f`.
No operator grants, production drafts or NetSuite transactions were changed.

All test runs used the standard isolated Compose runner with the shared
`mbbs-tests.slice` budget and bounded containers. Teardown was registered before
startup and removed containers, volumes and networks. Final Docker running/all
listings contain only the four production containers, with app/DB/Ollama healthy
and the webhook worker running. Logs, screenshots and JSON evidence are in
`test-artifacts/customer-pickup-lookup-access/`.

Reproduce on this host with its captured historical/current app snapshots:

```sh
bash server/tools/customer-pickup-lookup-access-check.sh
```

Node v20.20.2; existing pinned repository tooling and prepared browser image.
No new dependencies, schema, git initialization or commits. Full unrelated
repository suites, new type analysis, changed-runtime coverage and mutation runs
were not repeated because this follow-up changes only tests and verification
tools; the immutable runtime remains the release previously validated by 624
tests and its recorded gauntlet. These browser tests use synthetic data matching
the two live orders' yard layout and regular account grants. Live account and
order checks are read-only domain evaluations; no production browser session was
created or impersonated.
