# Shared menu order

Admin can save the order of Modules, Admin, Control, Dispatch, SCM, Sales and MBT
sidebar entries. The user confirmed that Sales, Dispatch and SCM menu cards use
the same saved sequence. Only order changes; existing roles, links, badges and
page access remain authoritative.

Acceptance checks:

- Defaults render in their current order. Partial saved orders append unlisted
  items in their original order, including future menu additions.
- Admin can drag rows or use accessible Move up / Move down buttons, switch
  groups without losing edits, save all edits, reset one group or reset all.
- Saves persist globally in PostgreSQL. Public navigation responses contain only
  orders/revision. Admin configuration and every write require a real Admin.
- Unknown groups/links, duplicates, invalid shapes and forged revisions fail
  without changing the stored order. Concurrent saves from one revision have
  exactly one winner; conflicts preserve the editor's unsaved work.
- Saving/resetting updates current navigation immediately. Other tabs/devices
  refresh on focus and within one minute. Failed reads retain working navigation.
- Reordering never adds a hidden menu, recreates a badge, or changes a link.
  Reset restores the original card DOM order; rerenders continue to follow the
  saved order. No additional persistent event connection is opened.
- Migration is additive/idempotent. Test environments use the standard bounded
  isolated Compose stack and are removed after every run.

No new dependencies, external integrations or checkpoint commits are needed.
The repository is already dirty; preserve unrelated source. Capture the existing
files before editing and apply only this feature's delta to any live release.
