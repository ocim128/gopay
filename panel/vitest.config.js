import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest configuration for Panel component tests.
 *
 * This config is intentionally separate from `vite.config.js` so the component
 * test setup never affects the production `vite build`. It compiles `.svelte`
 * files with the Svelte plugin and runs the suite in a jsdom environment.
 *
 * The `$app/*` SvelteKit ambient modules are not available outside the
 * SvelteKit build, so they are aliased to lightweight local mocks under
 * `src/test-mocks/app`. `$lib` is aliased to the real library directory.
 */
export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  resolve: {
    alias: {
      $app: fileURLToPath(new URL('./src/test-mocks/app', import.meta.url)),
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest-setup.js'],
    include: ['src/tests/**/*.test.js']
  }
});
