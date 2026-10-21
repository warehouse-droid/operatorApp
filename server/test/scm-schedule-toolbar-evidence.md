# Schedule toolbar release evidence

Deployed and verified at 2026-10-01T03:45:11.883895+00:00 on https://test.mbbsoperation.com.

The sort summary is removed from the rendered UI. The toolbar stays on one row with compact controls and a flexible search input. Narrow desktop spacing also keeps every conditional action visible. Column sorting indicators, Reset sort, row editing, filtering and the Columns menu continue to work.

Validation: 16/16 existing unit checks and 10/10 browser checks pass, with zero skips or new lint findings. Chromium layout previews at 1440, 1280 and 1180 pixels verify that every control fits on the same row, including Group and Clear filters. Each toolbar is 49px tall and the Columns menu remains usable. Browser exceptions: zero. Screenshot previews and measured geometry are under `test-artifacts/scm-schedule-toolbar-20261001`.

Only `public/scm-schedule.js`, `public/dispatch.css` and `public/scm-schedule.html` were deployed over the previous Schedule image. The complete 1172-file runtime tree matches the candidate. Backend files, migrations, dependencies, app configuration and the worker/database/Ollama containers are preserved. No migration or NetSuite write was performed. Five active-work guards were zero before publication. Local and public health, served asset hashes and protected preferences endpoint checks passed; POB03976's cached Note remains `for SOB121819`. No public connection retry or rollback was needed for this release.

Image: `mbbs-operator-app:scm-schedule-toolbar-20261001`. Image ID: `sha256:b9b613c71ead79a15b75306f68585dd399a1fd74ba386e43310fb7a35dbfd977`.

[Check results](../test-artifacts/scm-schedule-toolbar-20261001/checks.json), [layout measurements](../test-artifacts/scm-schedule-toolbar-20261001/layout.json), [release diff](../deployments/scm-schedule-toolbar-20261001/changes.patch), [live result](../deployments/scm-schedule-toolbar-20261001/result.json).

Read-only verification: `python3 tools/scm-schedule-toolbar-deploy.py verify`.

The subsequent [Special Request mini-panel release](special-po-mini-rows-evidence.md) is deployed at 2026-10-01T04:00:12.470173+00:00. It preserves all three Schedule assets. The current combined app is `mbbs-operator-app:special-po-mini-rows-20261001` (`sha256:f5b723bd222430ba2d21d5c3e86fb44cd96144ee0a29a42e961435fe083d5151`); read-only verification of the current app is `python3 tools/special-po-mini-rows-deploy.py verify`.
