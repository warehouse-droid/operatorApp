# Driver Camera Copy Cancellation — Executable Specification

Spec approval: obtained from the user's instruction to abandon the delivery
camera-copy change and keep ordinary Camera/Gallery upload.

## Required behavior

1. Driver job, DVIR, and BIN evidence screens continue to expose separate
   Camera and Gallery inputs.
2. Both inputs continue through the existing operational evidence pipeline;
   Gallery is never gated by a camera-copy setting.
3. The Driver shell contains no original-backup helper, directory picker,
   Google Drive/folder selection, synthetic download, or additional
   camera-original IndexedDB store.
4. Driver APIs no longer advertise or read the retired camera-copy gate.
5. A new Driver client/cache version replaces older cached copy-enabled assets.
6. The historical migration that introduced the retired database flag remains
   in migration history, but the flag is absent from the Admin gate catalog and
   has no runtime effect.

## Accepted limitation

No new local persistence is added for Operator online-only photos. Without a
reliable browser-local store, a failed upload cannot be guaranteed to survive a
refresh; the Operator must retry while the current page still holds the photo.
