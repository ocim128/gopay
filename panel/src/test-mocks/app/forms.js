// Test mock for SvelteKit's `$app/forms` module.
//
// The real `enhance` is a progressive-enhancement action that intercepts form
// submissions. For component tests we only need it to be a valid Svelte action
// (a function that may attach to a node and return an optional cleanup object),
// so this no-op stand-in lets pages that use `use:enhance` mount cleanly.

/**
 * No-op replacement for SvelteKit's `enhance` action.
 * @returns {{ destroy: () => void }}
 */
export function enhance() {
  return {
    destroy() {}
  };
}

/**
 * No-op replacement for SvelteKit's `applyAction` helper.
 * @returns {Promise<void>}
 */
export async function applyAction() {}

/**
 * No-op replacement for SvelteKit's `deserialize` helper.
 * @param {string} result
 * @returns {unknown}
 */
export function deserialize(result) {
  return result;
}
