// Global setup for Panel component tests.
// Adds the jest-dom matchers (e.g. toBeInTheDocument) to Vitest's expect.
import '@testing-library/jest-dom/vitest';

// jsdom does not implement the Web Animations API (`Element.prototype.animate`),
// which Svelte 5 uses to drive `transition:`/`in:`/`out:` directives (e.g. the
// drawer's fly/fade). Provide a minimal stub so transitions don't throw during
// component tests; the elements still mount synchronously and stay queryable.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function animate() {
    return {
      onfinish: null,
      oncancel: null,
      cancel() {},
      finish() {},
      pause() {},
      play() {},
      reverse() {},
      finished: Promise.resolve(),
      currentTime: 0,
      startTime: 0,
      playbackRate: 1,
      playState: 'finished',
      effect: null
    };
  };
}

// jsdom does not implement IntersectionObserver. Provide a minimal stub.
if (typeof global.IntersectionObserver === 'undefined') {
  global.IntersectionObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof window !== 'undefined' && typeof window.IntersectionObserver === 'undefined') {
  window.IntersectionObserver = global.IntersectionObserver;
}
