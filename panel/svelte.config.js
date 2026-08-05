import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * SvelteKit configuration for the Admin Panel.
 *
 * The Node adapter is used so the Panel runs as a standalone Node server that
 * can act as a backend-for-frontend (BFF): server-side `load` functions and
 * form actions forward requests to the REST_API while keeping the Admin session
 * cookie httpOnly (Requirement 12.5).
 *
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter()
  }
};

export default config;
