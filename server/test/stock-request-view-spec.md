# Stock Request stability and responsiveness

Background application updates must not rebuild the request pool or selected
detail on the Sales and SCM Regular and Special tabs. Relevant updates show a
quiet notice outside those panels; Refresh applies new data when the user is
ready. Existing top-bar notifications remain active.

Acceptance checks:

- Unrelated events cause no queue/detail loads or DOM changes. Relevant events,
  reconnects, focus, visibility and missed-event polling never replace pool,
  cards, toolbar or detail contents. Inputs, selection, focus and scroll remain.
- A manual Refresh applies current records and clears the notice only if no
  newer update arrived during that read. Failed checks/refreshes retain data.
- Selecting a different card preserves every pool node and paints detail from
  the already-loaded record immediately. Regular detail enrichment may follow
  the click, but an old response or response arriving after editing cannot
  replace current selection or edits. Same-card clicks do no work.
- Special selection does not refetch the queue. SCM PO-routing responses update
  only the routing section and never rebuild the surrounding detail or pool.
- Print-status polling signals changed data without rebuilding either panel.
  Expired Regular approvals disable SO controls in place; the server remains
  authoritative for actions and revisions.
- Tests use the standard bounded isolated Compose stack with teardown
  registered before startup. Test resources are removed and logs retained.

The release is a scoped frontend overlay on the running image. Preserve other
deployed changes, current runtime configuration and production data.
