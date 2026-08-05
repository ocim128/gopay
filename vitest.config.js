// Root Vitest configuration for the backend test suite.
//
// The backend (Node.js ESM) tests live under `src/**`. The SvelteKit panel in
// `panel/` has its own, separate Vitest setup (`panel/vitest.config.js`) with
// the Svelte plugin and a jsdom environment, so its `.svelte` component tests
// must NOT be collected by this root runner (which has no Svelte transform).
// Restricting `include` to `src/**` and excluding `panel/` keeps the two
// suites cleanly isolated.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.js'],
    exclude: ['node_modules/**', 'panel/**'],
    // Property-based tests run >= 100 iterations and several route PBTs build a
    // full Fastify app (and a memory-hard scrypt hash) per iteration. Under the
    // full suite's parallel load these legitimately exceed the 5s default, so a
    // higher per-test timeout is used to keep them reliable without reducing the
    // mandated iteration count.
    testTimeout: 60000,
  },
});
