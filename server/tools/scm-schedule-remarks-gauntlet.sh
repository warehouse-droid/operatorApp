#!/usr/bin/env bash
set -euo pipefail

npm run test:scm-schedule-remarks
npm run coverage:scm-schedule-remarks
npm run mutate:scm-schedule-remarks
npm run lint:scm-schedule-remarks
npm run secrets:scm-schedule-remarks
node src/scm-schedule-remark-harness.js
