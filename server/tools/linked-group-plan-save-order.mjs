import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

// Preserve the requested order and give every test file its own PostgreSQL
// clone. HTTP fixtures intentionally leave truck and plan rows behind.
process.exitCode = await runNodeTestFilesIsolated(process.argv.slice(2), {
  environment: process.env, label: 'Linked group save'
});
