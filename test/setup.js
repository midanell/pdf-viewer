import { vi } from "vitest";

// jsdom does not implement IntersectionObserver / ResizeObserver, the layout
// APIs viewer.js relies on, or requestIdleCallback. Install controllable stubs
// so tests can both run the code and drive observer callbacks synthetically.

// Registry of every observer instance created, so a test can grab the latest
// one and fire entries at its callback. Reset between tests via resetObservers().
globalThis.__observers = { intersection: [], resize: [] };

export function resetObservers() {
  globalThis.__observers.intersection.length = 0;
  globalThis.__observers.resize.length = 0;
}

class MockIntersectionObserver {
  constructor(callback, options = {}) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    globalThis.__observers.intersection.push(this);
  }
  observe(el) {
    this.targets.add(el);
  }
  unobserve(el) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  // Test helper: invoke the callback with synthetic entries.
  fire(entries) {
    this.callback(entries, this);
  }
}

class MockResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    globalThis.__observers.resize.push(this);
  }
  observe(el) {
    this.targets.add(el);
  }
  unobserve(el) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  fire(entries) {
    this.callback(entries, this);
  }
}

globalThis.IntersectionObserver = MockIntersectionObserver;
globalThis.ResizeObserver = MockResizeObserver;

// requestIdleCallback / cancelIdleCallback — run on the macrotask queue.
globalThis.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
globalThis.cancelIdleCallback = (id) => clearTimeout(id);

// jsdom throws on scrollIntoView; make it an inspectable no-op.
Element.prototype.scrollIntoView = vi.fn();
