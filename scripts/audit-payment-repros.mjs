// Regression checks for the payment audit; local databases and mocked providers only.
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'src/tests/payment-reliability.test.js'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
