# Driver PWA isolated workflow check

Requested: verify the normal Driver PWA workflow with Playwright in an isolated
container. Exercise the actual deployed UI/API with disposable data, no live
accounts and no NetSuite or Samsara writes. Simulate only external photo storage.

- Real login, failed-login feedback, route display, rest/resume and pickup.
- Normal and SOR dropoffs, two required photos, optional remarks and signatures.
- Camera/gallery file inputs, usable actions at 320px width, history/navigation.
- Online-only mode completion and server-persisted history after reload.
- Offline-enabled mode: installed shell reloads without a network, draft photos
  and notes recover, later stops remain usable, reconnect uploads and applies
  evidence exactly once with original signature wording.
- No page exceptions or server errors during normal journeys.

The first run exposed a false route-change warning after local instruction
translation. Fix only the comparison of local display metadata; real changes to
instructions, addresses, references, phone numbers, media and revision must still
trigger review. Preserve immutable source data and required-photo rules.

The existing online-only setting intentionally disables ordinary local photo and
note drafts. Its unfinished-draft reload behavior is not changed; recovery tests
apply to offline-enabled mode. Signature capture remains separately persisted.
Physical camera/GPS, live Samsara and remote object-store availability are outside
this isolated check. Record screenshots, traces and precise results.

The real offline-enabled journey also exposed a lost location-verification
receipt during same-stop refresh. Keep the receipt and accepted override only
while the authoritative stop remains unchanged. An online override must obtain a
server receipt first; preserve all server expiry, device and stop checks. Publish
the fixed frontend together as cache generation 44 without changing IndexedDB or
the offline protocol.

A repeat exposed a stale next-stop response when a previous completion became
applied during revalidation. Before blocking an action for an apparent server
cursor change, re-read the server once. Proceed only if that fresh response
matches the exact expected stop and has no cross-device pending evidence.
Actual route edits, review-required completions and cross-device evidence must
still block. The retry is bounded; no automatic mutation replay is introduced.

When a preceding local completion is still uploading, save the next Start in
the existing ordered ledger instead of sending it ahead of that completion to
the foreground endpoint. The first tap must start the local stop; synchronization
must apply the completion and start in order. Only pending predecessor
completions choose this path; unrelated, later or already-applied events do not.

After an offline shell reload, Chromium may report online while requests still
fail. The existing recorded offline state must prevent a sync hold from covering
the controls and prevent a new foreground Start. Actual reconnection still
synchronizes retained evidence. Leaving the network clears any visible sync
hold without clearing its events, photos or synchronization state.
