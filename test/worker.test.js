import { describe, it, expect, vi } from "vitest";

// Capture the GlobalWorkerOptions object the module mutates on import.
const { globalWorkerOptions } = vi.hoisted(() => ({ globalWorkerOptions: {} }));

vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: globalWorkerOptions }));

// Import AFTER the mock so the module's import-time side effects run against it.
import { PDF_ASSET_URLS } from "../src/worker.js";

describe("worker.js", () => {
  it("sets GlobalWorkerOptions.workerSrc to the unminified worker URL", () => {
    expect(globalWorkerOptions.workerSrc).toBeTypeOf("string");
    expect(globalWorkerOptions.workerSrc).toMatch(/pdf\.worker\.mjs$/);
    // dev build, not the minified one (per CLAUDE.md)
    expect(globalWorkerOptions.workerSrc).not.toMatch(/pdf\.worker\.min\.mjs$/);
  });

  it("exports all four asset URLs plus cMapPacked", () => {
    expect(PDF_ASSET_URLS).toMatchObject({ cMapPacked: true });
    for (const key of ["cMapUrl", "standardFontDataUrl", "wasmUrl", "iccUrl"]) {
      expect(PDF_ASSET_URLS[key]).toBeTypeOf("string");
    }
  });

  it("resolves each asset to an absolute URL", () => {
    // The exact subdirectory (cmaps/, wasm/, …) can't be asserted here: Vite
    // statically rewrites `new URL(`…${dynamic}`, import.meta.url)` at transform
    // time, so the runtime subpath isn't reproduced under vitest. What we can
    // verify is the contract that matters — each asset is configured as an
    // absolute URL, never left undefined (which would make getDocument throw).
    for (const key of ["cMapUrl", "standardFontDataUrl", "wasmUrl", "iccUrl"]) {
      expect(PDF_ASSET_URLS[key]).toMatch(/^(file|https?):\/\//);
    }
  });
});
