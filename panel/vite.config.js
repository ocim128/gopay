import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * Vite configuration for the Admin Panel.
 *
 * The Panel talks to the REST_API through server-side `load`/action code (a
 * backend-for-frontend pattern), using the `API_BASE` environment variable
 * (default `http://localhost:3000`). No browser-side proxy is required because
 * the httpOnly Admin session cookie is read and forwarded on the server.
 */
export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173
  }
});
