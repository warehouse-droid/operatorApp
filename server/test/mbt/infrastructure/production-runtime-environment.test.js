import assert from "node:assert/strict";
import test from "node:test";

import { assertIsolatedComposeConfig } from "../../support/test-foundation.mjs";

const CONTROLLED_COMPOSE = `
name: mbbs-mbt-p1-test
services:
  db:
    image: postgres:18-alpine@sha256:abc
    tmpfs:
      - /var/lib/postgresql/data
  app:
    image: mbbs-mbt-p1-runtime-check:latest
    build:
      context: ./server
      dockerfile: Dockerfile
    environment:
      NODE_ENV: "production"
      MBT_TEST_ISOLATED: "1"
      NETSUITE_DIRECT_ACCESS_ENABLED: "false"
      MBT_ENABLED: "false"
      MBT_NETSUITE_WRITES_ENABLED: "false"
    networks:
      mbt_test_internal:
        aliases:
          - mbt-web
  test:
    image: mbbs-mbt-p1-test-test:latest
    environment:
      MBT_TEST_ISOLATED: "1"
      NETSUITE_DIRECT_ACCESS_ENABLED: "false"
  e2e:
    image: mbbs-mbt-p1-test-test:latest
    environment:
      MBT_TEST_BASE_URL: http://mbt-web:3000
networks:
  mbt_test_internal:
    internal: true
`;

test("quality non-regression: the isolated production-image smoke requires production Node semantics", () => {
  assert.equal(assertIsolatedComposeConfig(CONTROLLED_COMPOSE), true);
  assert.throws(
    () => assertIsolatedComposeConfig(
      CONTROLLED_COMPOSE.replace('NODE_ENV: "production"', 'NODE_ENV: "test"')
    ),
    /isolated MBT test compose/i
  );
});
