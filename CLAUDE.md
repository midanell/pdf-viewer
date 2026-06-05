# PDF.js Custom Viewer — Project Instructions

Build a custom PDF viewer using Mozilla's PDF.js library (`pdfjs-dist`).
This is a vanilla JS/HTML/CSS project (no framework).

## Stack

- `pdfjs-dist` (latest v6.x) — PDF rendering engine
- Vanilla JS with ES modules
- No framework (React, Vue, etc.) unless explicitly requested

## Critical: worker configuration

PDF.js uses a Web Worker for parsing. The worker version MUST match the library version exactly.
Resolve the worker path with `import.meta.url` so it works under any static server without a bundler:

```js
import { GlobalWorkerOptions } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).href;
```

- Never skip setting `workerSrc` — without it, PDF.js falls back to a slow synchronous fake worker and logs a warning.
- Use `pdf.worker.mjs` (not `pdf.worker.min.mjs`) in development for readable stack traces.

## Critical: asset URLs

v6 moved JPEG2000/JBIG2 image decoding and ICC color to WebAssembly, and added `wasmUrl`/`iccUrl`
alongside the existing `cMapUrl`/`standardFontDataUrl`. When an asset is needed but its URL is not
configured, `getDocument` throws. Always pass all four to `getDocument`:

```js
const asset = (path) =>
  new URL(`../node_modules/pdfjs-dist/${path}`, import.meta.url).href;

export const PDF_ASSET_URLS = {
  cMapUrl: asset("cmaps/"),           // Adobe CMap files (CJK fonts)
  cMapPacked: true,
  standardFontDataUrl: asset("standard_fonts/"),
  wasmUrl: asset("wasm/"),            // JPEG2000/JBIG2/QCMS decoders
  iccUrl: asset("iccs/"),             // ICC color profiles
};
```

Then pass them into `getDocument`:

```js
const src =
  typeof url === "string" || url instanceof URL
    ? { url, ...PDF_ASSET_URLS }
    : url instanceof Uint8Array
      ? { data: url, ...PDF_ASSET_URLS }
      : { ...url, ...PDF_ASSET_URLS };

const loadingTask = pdfjsLib.getDocument(src);
```

With all URL params set to valid same-origin URLs, the worker auto-enables `useWorkerFetch` and
fetches assets directly — no main-thread involvement.

## Architecture: three layers per page

Every PDF page renders as three stacked layers inside a wrapper div with `position: relative`:

1. **Canvas** (z-index 1) — visual bitmap rendering via `page.render()`
2. **Text layer** (z-index 2) — transparent positioned `<span>` elements for text selection, via the `TextLayer` class
3. **Annotation layer** (z-index 3) — clickable links, form fields, highlights, via the `AnnotationLayer` class

All three layers must use the SAME viewport object for alignment.

## Loading a PDF

```js
const loadingTask = pdfjsLib.getDocument(src); // src = config object (see above)
loadingTask.onProgress = ({ loaded, total }) => {
  /* update progress bar */
};
const pdf = await loadingTask.promise;
```

- `getDocument()` returns a `PDFDocumentLoadingTask`, NOT a promise. Access the promise via `.promise`.
- For file uploads: pass `{ data: new Uint8Array(await file.arrayBuffer()), ...PDF_ASSET_URLS }`.
- For password-protected PDFs: add `password` to the config object.
- Cancel mid-load with `loadingTask.destroy()`.

## Rendering a page

Pages are 1-indexed. `getPage(0)` throws.

```js
const page = await pdf.getPage(1);
const viewport = page.getViewport({ scale: 1.5 });
```

### Canvas rendering with retina support

Pass the `canvas` element directly (v6-preferred) and supply the DPR scale via the `transform`
parameter. v6 fetches the context itself, so there is no need for a manual `ctx.setTransform`:

```js
const dpr = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = Math.floor(viewport.width * dpr);
canvas.height = Math.floor(viewport.height * dpr);
canvas.style.width = Math.floor(viewport.width) + "px";
canvas.style.height = Math.floor(viewport.height) + "px";

const renderTask = page.render({
  canvas,
  viewport,
  transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
});
await renderTask.promise;
```

- Set canvas dimensions BEFORE calling render — resizing a canvas clears it.
- `page.render()` returns a `RenderTask` with `.promise` and `.cancel()`.
- Cap DPR at 2 (`Math.min(window.devicePixelRatio || 1, 2)`) — 3× and 4× screens don't benefit visually and triple/quadruple the canvas memory cost.
- The legacy `canvasContext` parameter still works in v6 for backwards compatibility, but `canvas` + `transform` is the clean v6 path.

### CSS scale variables on the page wrapper

v6's `pdf_viewer.css` sizes text-layer fonts and annotation popups through two CSS custom properties.
**Both must be set on the page wrapper element whenever scale changes**, because `pdf_viewer.css` only
defines `--total-scale-factor` on `.pdfViewer .page` — a class structure custom viewers don't use:

```js
wrapper.style.setProperty("--scale-factor", String(viewport.scale));
wrapper.style.setProperty("--total-scale-factor", String(viewport.scale));
```

- `--scale-factor` is still used by some annotation inline styles.
- `--total-scale-factor` drives the text-layer font-size calc chain in v6 (`--text-scale-factor → --total-scale-factor`). Without it, all text-layer `calc()` expressions are invalid, fonts collapse, and selection highlights misalign.
- Set both on the wrapper *before* constructing or updating the `TextLayer`. One call per render/resize covers both layers since the wrapper is their common ancestor.

### Text layer

Import `TextLayer` and `setLayerDimensions` from `pdfjs-dist`. The text layer CSS from
`pdfjs-dist/web/pdf_viewer.css` is required.

```js
import { TextLayer, setLayerDimensions } from "pdfjs-dist";

const textDiv = document.createElement("div");
textDiv.className = "textLayer";
container.appendChild(textDiv);

// Size the div using setLayerDimensions (sets width/height as CSS calc expressions)
setLayerDimensions(textDiv, viewport);

// Use streamTextContent for streaming — avoids waiting for the full page text
const textLayer = new TextLayer({
  textContentSource: page.streamTextContent(),
  container: textDiv,
  viewport,
});
await textLayer.render();
```

To update after a zoom/rotation change (no re-render needed):

```js
setLayerDimensions(textDiv, viewport);
textLayer.update({ viewport });
```

To cancel an in-flight render:

```js
textLayer.cancel();
```

- The page wrapper MUST have `position: relative`.
- `page.streamTextContent()` and `page.render()` are independent — start them concurrently with `Promise.all`.
- `TextLayer` is a class, not a free function. `renderTextLayer` from v4 no longer exists.

### Annotation layer

Import `AnnotationLayer` from `pdfjs-dist`. It is a class, not a namespace with a static `render`.

```js
import { AnnotationLayer } from "pdfjs-dist";

const annotDiv = document.createElement("div");
annotDiv.className = "annotationLayer";
container.appendChild(annotDiv);

const annotViewport = viewport.clone({ dontFlip: true });

const annotLayer = new AnnotationLayer({
  div: annotDiv,
  page,
  viewport: annotViewport,
  linkService,
  accessibilityManager: null,
  annotationCanvasMap: null,
  annotationEditorUIManager: null,
  structTreeLayer: null,
});

const annotations = await page.getAnnotations();
await annotLayer.render({
  viewport: annotViewport,
  div: annotDiv,
  annotations,
  page,
  linkService,
  renderForms: true,
});
```

To update after a zoom/rotation change:

```js
annotLayer.update({ viewport: viewport.clone({ dontFlip: true }) });
```

- **ALWAYS pass `viewport.clone({ dontFlip: true })`** to the constructor and `render` — the canvas flips internally; the annotation layer does its own Y-axis flip via CSS. Without `dontFlip: true`, every annotation is mirrored vertically.
- `renderForms: true` makes Widget annotations (text inputs, checkboxes, dropdowns) into real HTML form elements.
- `annotLayer.render()` returns a promise in v6.

### Link service (minimal implementation)

```js
export function createLinkService(pdf, { onNavigate } = {}) {
  return {
    pagesCount: pdf?.numPages ?? 0,
    page: 1,
    rotation: 0,
    isInPresentationMode: false,
    externalLinkEnabled: true,

    async goToDestination(dest) {
      const destination =
        typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      if (!destination) return;
      const pageIndex = await pdf.getPageIndex(destination[0]);
      onNavigate?.(pageIndex + 1); // getPageIndex is 0-based
    },
    goToPage(val) {
      onNavigate?.(val);
    },
    addLinkAttributes(link, url, newWindow) {
      link.href = url;
      link.target = newWindow ? "_blank" : "_self";
      link.rel = "noopener noreferrer";
    },
    getDestinationHash() { return "#"; },
    getAnchorUrl(hash) { return "#" + hash; },
    setHash() {},
    executeNamedAction() {},
    executeSetOCGState() {},
  };
}
```

## Multi-page layout

Stack all pages vertically in a scroll container. Each page gets a wrapper div with `data-page-number`:

```html
<div class="scroll-container" style="overflow-y: auto;">
  <div data-page-number="1" style="position: relative; margin-bottom: 12px;">
    <canvas></canvas>
    <div class="textLayer"></div>
    <div class="annotationLayer"></div>
  </div>
  <!-- ... more pages ... -->
</div>
```

## Navigation

- **Go to page**: `container.querySelector('[data-page-number="N"]').scrollIntoView({ behavior: 'smooth' })`
- **Scroll-based page detection**: use `IntersectionObserver` with `root: scrollContainer` and `threshold: [0, 0.25, 0.5, 0.75, 1]`. Track which page has the highest `intersectionRatio` — that's the current page.
- **Prevent feedback loops**: when programmatically scrolling (via prev/next buttons or page input), set a `scrollingTo` flag for ~600ms to suppress observer-driven page changes during the smooth scroll animation.

## Search

For manual search without the full PDFFindController stack:

1. Walk every `<span>` text node in `.textLayer` divs using `TreeWalker(layer, NodeFilter.SHOW_TEXT)`.
2. Match with a regex (escaped, case-insensitive by default).
3. Wrap matches in `<mark>` elements.
4. Navigate between matches with `.scrollIntoView({ block: 'center' })` and toggle a `.current-match` class.
5. To clear: replace all `<mark>` elements with their text content, then call `.normalize()` on each text layer div.
6. Debounce search input by ~250ms.

## Lazy rendering (performance-critical for large docs)

Do NOT render all pages eagerly. Use a placeholder + IntersectionObserver pattern:

1. **Create placeholders** for every page with correct dimensions (from `page.getViewport({ scale })`) so the scrollbar is accurate. No canvas yet.
2. **Observe each placeholder** with `IntersectionObserver({ root: scrollContainer, rootMargin: '200px' })`. The `rootMargin` pre-renders pages 200px before they enter view.
3. **On intersection**: render canvas + text layer + annotation layer.
4. **On exit** (optional): cancel in-flight renders; for extreme memory savings, discard the canvas entirely and reset to placeholder state.

### Page states

```
PENDING → RENDERING → RENDERED
           ↓ (scrolled away)
         CANCELLED → PENDING (can re-render later)
```

### Canvas caching

Use an LRU cache (8–20 pages) keyed by `pageNumber + scale`. On cache hit, use `ctx.drawImage(cachedCanvas, 0, 0)` instead of re-rendering from the worker. Invalidate the entire cache on zoom/scale change.

### Cancel in-flight renders correctly

`renderTask.cancel()` is async — the task rejects with `RenderingCancelledException`. Always `await` the rejection before starting a new render on the same canvas:

```js
if (activeTask) {
  activeTask.cancel();
  await activeTask.promise.catch((e) => {
    if (e?.name !== "RenderingCancelledException") throw e;
  });
}
```

Starting a new render without awaiting cancellation causes two renders to race and corrupt each other.

## Zoom

- `scale` in `getViewport({ scale })` is relative to 72 DPI. `scale: 1` = 72dpi, `scale: 2` = 144dpi.
- Common range: 0.5 to 4.0 in 0.25 increments.
- **Fit to width**: `scale = containerWidth / page.getViewport({ scale: 1 }).width`.
- On zoom change: cancel renders, resize all page wrappers, re-render only visible pages (let IntersectionObserver handle it).

## Resize handling

- Use `ResizeObserver` on the scroll container (not `window.resize`) — better for split layouts.
- Debounce by ~150ms before re-rendering.

## Memory management

- Call `page.cleanup()` after rendering to free decoded font/image data. It's automatically re-fetched from the worker if needed again.
- Canvas bitmaps are the most expensive resource (~3MB each at 1.5× scale, 2× DPR). Cache 8–20; discard the rest.
- Text content and annotation data are cheap to recreate — discard freely.
- The `PDFDocumentProxy` is kept for the lifetime of the viewer. Never recreate it.

## Common mistakes

- Forgetting `workerSrc` — causes silent fallback to main-thread parsing
- Mismatched worker and library versions — causes cryptic errors
- Missing `cMapUrl`, `standardFontDataUrl`, `wasmUrl`, or `iccUrl` — v6 throws when a PDF needs CJK fonts, JPEG2000/JBIG2 images, or ICC color; always pass all four URL params
- Setting only `--scale-factor` without `--total-scale-factor` — v6 text-layer font sizes are computed via `--total-scale-factor`; omitting it makes all `calc()` invalid and misaligns text selection
- Resizing canvas after `render()` — erases the drawing
- Using `getPage(0)` — pages are 1-indexed
- Missing `position: relative` on page wrapper — text and annotation layers misalign
- Missing `dontFlip: true` for annotation viewport — annotations are vertically mirrored
- Two concurrent renders on the same canvas without canceling — corrupted output
- Rendering all pages eagerly on a 100+ page document — browser runs out of memory
- Using `renderTextLayer` (removed in v5) or static `AnnotationLayer.render()` (removed in v5) — use the `TextLayer` and `AnnotationLayer` classes

## File structure

```
root/
├── CLAUDE.md
└── src/
    ├── viewer.js          # PdfViewer class — orchestrates all subsystems
    ├── pageRenderer.js    # canvas + text + annotation rendering per page
    ├── worker.js          # sets workerSrc + exports PDF_ASSET_URLS
    ├── toolbar.js         # imperative toolbar DOM, responsive layout
    ├── search.js          # full-text search over text layer spans
    ├── thumbnails.js      # lazily rendered thumbnail sidebar (scale ~0.2)
    ├── loading.js         # loading overlay (indeterminate and progress modes)
    └── linkService.js     # minimal PDF.js link service for annotation navigation
└── demo/                  # index.html, main.js, and sample PDFs for testing
```

## Build targets

| Asset              | Target gzip size |
| ------------------ | ---------------- |
| pdf.min.mjs        | ~400KB           |
| pdf.worker.min.mjs | ~550KB           |
| Viewer code        | <50KB            |
