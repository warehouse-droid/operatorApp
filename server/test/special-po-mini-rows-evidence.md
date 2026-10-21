# Special Request mini-panel and wording release

Deployed and verified at 2026-10-01T04:00:12.470173+00:00 on https://test.mbbsoperation.com.

The mini panel uses two desktop rows: Method, Status, Pickup Yard, Sp.O and Packing Slip/Ref in the first; Destination Override, Remark, Note and Save Schedule in the second. The Open PO Split link is removed, including loading/error states. Narrow phone screens retain responsive stacking. Stock readiness now uses “Ready for Arrangement,” with its boolean value unchanged. Generated item descriptions omit the vendor/brand prefix and join trimmed name, colour, size and detail spec with a single space, skipping empty fields. Sales/SCM displays, new Sales draft defaults and quote previews share the formatter; existing reviewed order descriptions remain stored as supplied.

Validation: 18/18 unit/PDF/property checks and 11/11 Chromium browser checks pass, with zero failures or skips and zero new lint findings. Browser measurements confirm two desktop rows at 1440, 1280 and 1024 pixels, with all nine fields/actions contained in the panel. Tests cover the readiness label, exact Sales draft description, saved payload, quote description, pricing/packing retention, PALLET creation, failed-input retention, real Note save path, local-only split Note edits, aliases, late responses and mobile page overflow.

Only seven public assets were overlaid on the deployed toolbar app. The complete 1172-file runtime tree matches the candidate; the three Schedule assets remain byte-for-byte intact. Live stylesheet ordering was preserved separately from the workspace HTML. Backend files, migrations, dependencies, app configuration and worker/database/Ollama container identities are unchanged. No migration, live test order or NetSuite write was performed for verification. Local/public health and all seven served asset hashes passed, as did the protected preference endpoint and POB03976's cached `for SOB121819` Note check. No public connection retries or rollback were needed.

Image: `mbbs-operator-app:special-po-mini-rows-20261001`. Image ID: `sha256:f5b723bd222430ba2d21d5c3e86fb44cd96144ee0a29a42e961435fe083d5151`.

[Checks](../test-artifacts/special-po-mini-rows-20261001/checks.json), [layout measurements](../test-artifacts/special-po-mini-rows-20261001/browser/mini-layout.json), [desktop preview](../test-artifacts/special-po-mini-rows-20261001/browser/routing-saved.png), [scoped diff](../deployments/special-po-mini-rows-20261001/changes.patch), [live result](../deployments/special-po-mini-rows-20261001/result.json).

Read-only verification: `python3 tools/special-po-mini-rows-deploy.py verify`.
