// Test mock for SvelteKit's `$app/navigation` module.
//
// Pages call `goto` to redirect (for example, back to the login page when a
// session expires). In component tests there is no router, so these are no-ops
// that resolve immediately.

/**
 * No-op replacement for SvelteKit's `goto`.
 * @returns {Promise<void>}
 */
export async function goto() {}

/**
 * No-op replacement for SvelteKit's `invalidate`.
 * @returns {Promise<void>}
 */
export async function invalidate() {}

/**
 * No-op replacement for SvelteKit's `invalidateAll`.
 * @returns {Promise<void>}
 */
export async function invalidateAll() {}
