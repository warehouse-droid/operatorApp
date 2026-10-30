# Final collection waiting state — 2026-10-23

Spec approval: not obtained (autonomous implementation of the user's correction).
Use the existing old-coder workflow; no dependencies, commits or migrations.

1. A final Collection such as BIN00002C remains visible in the normal pool and
   search. While its rental has unfinished delivery or exchange work, its card
   has a light red background, is not draggable, and explains which jobs remain.
2. All exchange parts matter, including old-bin collection/dump/return work and
   replacement delivery. Unconfigured exchange orders also block final collection.
   Completed/cancelled jobs and other rentals do not block it. An exchange's own
   Collection leg is not a final Collection and must remain plannable.
3. Route editing remains available. The existing physical collection bin, customer
   time windows, cargo and previous edit-lock behavior remain unchanged.
4. New assignments through the MBT planning command/board must reject a waiting
   final collection atomically, including a stale browser attempting to submit it.
   Once all required work completes, the card unlocks and the current assigned bin
   can be planned. Started work and already-issued historical instructions retain
   their existing execution behavior; this change does not rewrite live plans.
5. Refresh recomputes this state even when only a different job's status changed,
   without requiring a revision change on the final Collection itself.

This changes the prior planner behavior that allowed an unstarted final Collection
to be assigned before Delivery completed. Preserve the old cross-plan release test
as an explicit historical-assignment fixture, with its assertions unchanged.
The previous pool assertion that every configured job is immediately dispatchable
is replaced by explicit Delivery=true and waiting-final-Collection=false assertions,
including the expected predecessor reference. This is the requested policy change.

Failure model: premature final collection (query/card and command tests), confusing
or inaccessible UI (real Chromium drag/style/message/select/edit tests), unrelated
rentals or exchange legs blocked (isolation cases), stale cached eligibility
(completion then same-page refresh), and partial plan writes (rollback snapshots).
Use bounded disposable tests, changed-line coverage, static checks, properties and
fault injection, then deploy only a narrow overlay on the captured current image.

Regression clarification: the cross-date bin re-selection test also creates a
Collection assignment before Delivery finishes. Its setup now explicitly recreates
a historical assignment through the existing low-level primitive. Keep every lease,
rollback, physical-bin and publication assertion unchanged: existing plans still
need these guarantees even though new assignments now wait for Delivery completion.

The historical re-selection regression exposed an internal withdraw/rebuild cycle:
preserve a same-plan assignment using the original server-locked visit. A client
must not bypass the hold by sending a fabricated previous assignment in its request.
