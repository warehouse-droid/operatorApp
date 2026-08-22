# Driver PWA hard site reset specification

## Scope

Provide an emergency, online-only recovery path for iOS Chrome/WebKit when the
normal Driver Reload and cache Repair controls cannot replace a stale PWA
generation. The path clears this origin's browser state and returns the driver
to a fresh login. It does not deploy the change and cannot remove entries from
Chrome's browsing-history list.

No new dependency is required. Verification uses the repository's Node,
ESLint, Docker Compose, PostgreSQL, and Playwright/WebKit toolchain.

## Failure model and executable scenarios

1. **Viewing is non-destructive.** Given any Driver state, GET `/reset-driver`
   returns a no-store, non-frameable warning page and does not return
   `Clear-Site-Data`. Its erase control stays disabled until the operator checks
   an explicit data-loss confirmation.
2. **Cross-site and accidental POSTs fail closed.** A POST without
   `X-MBBS-Driver-Site-Reset: confirm` returns 400; a cross-site Fetch Metadata
   request returns 403. Neither response carries `Clear-Site-Data`.
3. **Confirmed reset clears the whole origin.** A confirmed same-origin POST
   returns `Clear-Site-Data: "cache", "cookies", "storage"`, no-store headers,
   and a cache-busted `/driver` URL. The standalone page also unregisters
   service workers and explicitly clears CacheStorage, IndexedDB,
   local/session storage, and readable cookies for WebKit versions that do not
   act on the header.
4. **Server credentials are revoked first.** When a valid Driver bearer token
   is present, the corresponding server session is revoked before local
   credentials are erased. Matching offline grants are also revoked.
5. **Stale workers cannot intercept recovery.** `/reset-driver` remains outside
   the `/driver` service-worker scope and is served without cached external
   assets.
6. **The real WebKit flow recovers login.** Starting with an active Driver
   worker plus probe data in local storage, session storage, cookies,
   CacheStorage, and IndexedDB, confirmation removes every probe and renders a
   fresh Driver Login under the current worker generation.
7. **Normal Repair remains non-destructive.** The existing Repair action still
   preserves login, offline IndexedDB evidence, the offline-mode sentinel, and
   non-Driver MBBS caches.
8. **No forced protocol cutover.** The deployable shell receives a new atomic
   asset/cache generation, while the Driver client protocol version remains
   `2026.08.12.3`.
9. **Reset discovery is update-screen only.** The Driver PWA renders exactly
   one visible link to `/reset-driver`, and that link belongs to the
   version-update-required screen. Login, normal Driver work, online-only
   status, offline status, and ordinary Repair UI do not advertise the
   destructive reset. The delivery-only asset generation advances to
   `20260818-driver-site-reset-v2` / shell v32 so an existing v31 worker cannot
   keep serving the old three-link UI.

## Safety invariants

- The warning must name unsynchronized actions and photos as permanent-loss
  risks.
- No automatic reset occurs on page load, login failure, Reload, or Repair.
- Normal and login screens must not expose a hard-reset control; the driver
  must first be in the explicit version-update-required state.
- The reset remains usable without a valid Driver session so a stale login can
  still be repaired.
- Production containers and data are never used by the test gauntlet.
