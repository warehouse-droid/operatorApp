# Transfer Dependency Source Backorder

## Authorized behavior

The SCM user may explicitly allow one draft Transfer Dependency proposal to
create a NetSuite Transfer Order whose source quantity is above the current
NetSuite Available quantity. Automatic suggestion generation remains capped by
availability and the default remains protected.

## Executable scenarios

1. **Protected by default**
   - Given a draft proposal requests 1 PALLET at a source with 0 Available,
   - when source backorder has not been enabled,
   - then creation validation fails with the existing source-availability
     error and no NetSuite request begins.

2. **Explicit proposal opt-in**
   - Given the same proposal and current inventory,
   - when an SCM user saves `Allow source stock backorder`,
   - then creation validation succeeds and reports a PALLET backorder of 1.

3. **Mixed proposal safety**
   - Given several proposals consume the same item and source,
   - when only some proposals allow backorder,
   - then the non-opted-in quantity must still fit inside current Available;
     only the opted-in quantity may form the shortfall.

4. **Persistence and audit**
   - New and regenerated proposals default to disabled.
   - Saving a changed setting persists it on that proposal and writes the
     actor, before/after value, and proposal identity to Dispatch audit.
   - Creation audit records exact item, source, requested, available, and
     backorder quantities.

5. **SCM visibility**
   - Every editable proposed TO shows the setting.
   - Enabled proposals show the current calculated source shortfall when the
     inventory matrix contains that item, and otherwise state that creation
     will perform the authoritative check.

6. **Performance and compatibility constraints**
   - Suggestion generation remains availability-capped.
   - Confirmation uses the existing single bounded inventory query and adds no
     polling, network request, dependency, or per-line database query.
   - Existing reservation overrides, incomplete-coverage behavior, NetSuite
     recovery, and created-TO revision behavior remain unchanged.

## Deployment contract

- Additive nullable-free Boolean migration with default `false`.
- Build and test before production cutover.
- Apply the migration while the existing application remains online.
- Recreate only the application container; database and Ollama stay online.
- Target measured application interruption below three seconds and abort the
  cutover when host CPU pressure is unsafe.
