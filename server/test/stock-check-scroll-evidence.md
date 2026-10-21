# Stock Check scrolling fix — 2026-10-14

The Stock Check pages inherited hidden body overflow and a fixed-height grid from
`dispatch.css`. The fix scopes normal document scrolling and natural content
height to `body.stock-check-page` and `#stockCheckApp`. Narrow controls, including
long vendor names, now fit beside the existing sidebar. Tables retain horizontal
scrolling. The stylesheet URL is versioned so a page refresh loads the correction.

Only `public/scm-stock-check.css` and `public/scm-stock-check.html` changed in the
published application. All other published file hashes match the healthy initial
Stock Check release. No vendor stock check or catalog refresh was run for this
layout fix. The existing vendor credentials, products, results and screenshots
remain in application data.

Regression evidence: before the fix the existing three browser flows passed,
while both new wheel-scrolling tests failed. With the final fix, all five browser
tests passed. The new tests reach the final controls on the catalog, tester and
setup pages at both 1440×720 and 390×600, and assert the document fits the viewport.
Desktop and mobile layout bounds and screenshots are retained in the artifacts.
The complete module run passed **69/69**. Lint, domain/vault type checks and secret
scan passed; the exact runtime image also booted healthy against synthetic data.

Commands: `bash server/tools/stock-check-tests.sh browser-scroll-green-3`,
`STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-20261014/candidate bash server/tools/stock-check-tests.sh final`,
and the same runner's `boot-green` and `static` stages. Tests use the repository's
bounded isolated Compose services with registered teardown. Production data was
not mounted into test containers.

The live HTTPS pages were checked for the corrected body class and versioned
stylesheet, and the served stylesheet bytes match the reviewed source. The
application is healthy; its database, webhook worker and Ollama service were
preserved. Both `docker ps` and `docker ps -a` contain only the four production
containers, with no remaining Stock Check test networks or database volumes.
Deployment hashes, timestamps and cleanup details are in
`test-artifacts/stock-check/scroll-fix-evidence.json`.

Initial release evidence was retained in
`test-artifacts/stock-check/initial-release-evidence`. This fix is limited to page
layout; the broader initial-release coverage and vendor-adapter limits still
apply. Spec clarification H records the scrolling requirement; spec approval
was not obtained (autonomous run under the user's authorized correction).
