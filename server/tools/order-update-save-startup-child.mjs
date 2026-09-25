import { takeCoverage } from 'node:v8';
import { startServer } from '../src/server.js';
// Shut down only this isolated process, preserving real startup coverage.
process.once('SIGTERM', () => { takeCoverage(); process.exit(0); });
await startServer();
