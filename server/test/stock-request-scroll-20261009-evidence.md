# Request scrolling: SPREQ-000063

The change lets wheel and touch scrolling continue from the request list into
the page when the list reaches an edge. Regular Request refreshes keep the
existing list visible while fetching, which avoids shrinking the page and
moving its scroll position. Both Sales and SCM use these changes.

The runtime overlay contains only `stock-requests.css`, the two Regular
Request scripts, and the two request HTML files with updated asset URLs.

## Reproduction

The Playwright fixture uses the deployed public assets and a read-only capture
of SPREQ-000063 (11 lines and its 62-case queue), plus STREQ-000093 (3 lines and
its 8-request queue). Selected structured personal fields are masked while
preserving their string lengths. API calls are intercepted locally, stock
mutations are rejected, and no production credentials are provided to tests.

- With the deployed `overscroll-behavior: contain`, all 12 Chromium combinations
  (Sales/SCM, Special/Regular, 1440/1024/390-pixel widths) fail the queue-edge
  wheel handoff. All eight WebKit combinations at desktop/phone widths also
  remain at document scroll position zero when wheeling at the queue edge.
- Regular refresh at the bottom of the phone layout moves the document by
  138 pixels in both Sales and SCM. The Loading placeholder temporarily
  replaces the queue. Keeping the current cards visible prevents that change.
- Continuous wheels through the details did not reproduce an upward document
  reset in Chromium or WebKit. Saved Special text size +8 also held the bottom
  position. This limits the conclusion: the patch fixes the reproduced faults;
  a browser-specific reset during scrolling alone has not been established.

The first CDP `synthesizeScrollGesture` probe did not move the page and is not
touch evidence. Touch tests use actual `dispatchTouchEvent` start/move/end
sequences, whose movement was first calibrated against the document. Browser
compositor rounding can consume a first gesture at the list's final fractional
pixel; the next gesture must hand off to the page. The original containment
continues blocking handoff.

## Verification

The focused tests check queue handoff in both directions, reaching the end of
the actual detail, returning to the top, Refresh preserving the bottom, steady
downward touch movement, background events preserving visible text, unchanged
form values, no stock mutations, and no page errors. Existing long-request,
audit, view, waitlist, and declined-stock-check editing tests also run.

Type checking compares the same module graph before and after the change:
580 existing diagnostics on each side, zero new diagnostics. Runtime lint is
compared to its deployed baseline; the test and helper lint checks must pass.

Results and screenshots are under
`server/test-artifacts/stock-request-scroll-20261009/`. A final successful
`summary.json`, `static.json`, and `cleanup-final.json` are mandatory release
gates. WebKit candidate evidence covers eight layouts with no reversals or
page errors and successful wheel handoff in every layout.

The final regression run passed **68/68 tests** with zero skipped tests.

All browser runs use the repository's isolated Compose configuration and the
bounded `mbbs-tests.slice`. No test database is started. Signal/finally teardown
is registered before launch and removes the exact task containers and network
with `down --volumes --remove-orphans`. Cleanup records both `docker ps` and
`docker ps -a`, task container/network/volume absence, and production health.
Concurrent disposable tests owned by other tasks are recorded without removal.

## Release

The release is built as a five-file overlay on the current production image.
Its task patch, original assets, and rollback image are retained under
`server/deployments/stock-request-scroll-20261009/`. Publication verifies the
source hashes, bytes served by the live application, application health,
unchanged runtime configuration, and unchanged dependency images/configuration.
It makes no database writes and checks that in-flight application writes have
finished before restarting the application service. Any incomplete publication
automatically restores the original image.

Published image: `sha256:2403cedb7e509a94d6a7c7a162206bec3bb2bd24cfeec9187ce4e45b8cda4998`.
The production service is healthy, its five served asset hashes match the
verified candidate, and its configuration and dependency configuration/images
match the prior release. SPREQ-000063 remains at revision 14 in
`await_customer_confirmation`. The fresh capture contains 63 Special cases.

After publication, fresh live assets and read-only request data are captured
again and the focused Playwright checks run against those exact deployed assets.
`live.json`, `live.log`, and `cleanup-live.json` record the outcome.

The post-publication check passed **20/20 tests** against `live-public-after`
and `requests-after.json`. `live-browser.json` records those counts. Final task
teardown passed: no task test containers in either Docker listing, no task
network or volume, and production healthy. A final production verification
also confirms the served hashes and preserved service/dependency configuration.
