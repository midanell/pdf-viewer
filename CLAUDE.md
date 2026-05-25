# PDF.js Custom Viewer — Project Instructions

Build a custom PDF viewer using Mozilla's PDF.js library (`pdfjs-dist`).
This is a vanilla JS/HTML/CSS project (no framework).

## Stack

- `pdfjs-dist` (latest v4.x) — PDF rendering engine
- Vanilla JS with ES modules
- No framework (React, Vue, etc.) unless explicitly requested

## Critical: worker configuration

PDF.js uses a Web Worker for parsing. The worker version MUST match the library version exactly.

```js
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
```

- Never skip setting `workerSrc` — without it, PDF.js falls back to a slow synchronous fake worker and logs a warning.

## Architecture: three layers per page

Every PDF page renders as three stacked layers inside a wrapper div with `position: relative`:

1. **Canvas** (z-index 1) — visual bitmap rendering via `page.render()`
2. **Text layer** (z-index 2) — transparent positioned `<span>` elements for text selection, via `renderTextLayer()`
3. **Annotation layer** (z-index 3) — clickable links, form fields, highlights, via `AnnotationLayer.render()`

All three layers must use the SAME viewport object for alignment.

## Loading a PDF

```js
const loadingTask = pdfjsLib.getDocument(src); // src = URL string, Uint8Array, or config object
loadingTask.onProgress = ({ loaded, total }) => {
  /* update progress bar */
};
const pdf = await loadingTask.promise;
```

- `getDocument()` returns a `PDFDocumentLoadingTask`, NOT a promise. Access the promise via `.promise`.
- For file uploads: `new Uint8Array(await file.arrayBuffer())`.
- For password-protected PDFs: `pdfjsLib.getDocument({ url, password })`.
- Cancel mid-load with `loadingTask.destroy()`.

## Rendering a page

Pages are 1-indexed. `getPage(0)` throws.

```js
const page = await pdf.getPage(1);
const viewport = page.getViewport({ scale: 1.5 });
```

### Canvas rendering with retina support

```js
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.floor(viewport.width * dpr);
canvas.height = Math.floor(viewport.height * dpr);
canvas.style.width = Math.floor(viewport.width) + "px";
canvas.style.height = Math.floor(viewport.height) + "px";
const ctx = canvas.getContext("2d");
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
await page.render({ canvasContext: ctx, viewport }).promise;
```

- `setTransform(dpr, 0, 0, dpr, 0, 0)` is the entire retina fix. Without it, text looks blurry on high-DPI screens.
- Set canvas dimensions BEFORE calling render — resizing a canvas clears it.
- `page.render()` returns a `RenderTask` with `.promise` and `.cancel()`.

### Text layer

Import `renderTextLayer` from `pdfjs-dist`. The text layer CSS from `pdfjs-dist/web/pdf_viewer.css` is required.

```js
const textContent = await page.getTextContent();
const textDiv = document.createElement("div");
textDiv.className = "textLayer";
textDiv.style.cssText = `position:absolute; top:0; left:0; width:${Math.floor(viewport.width)}px; height:${Math.floor(viewport.height)}px;`;
container.appendChild(textDiv);
await renderTextLayer({
  textContentSource: textContent,
  container: textDiv,
  viewport,
}).promise;
```

- The page wrapper MUST have `position: relative`.
- Text spans need `transform-origin: 0% 0%` (provided by pdf_viewer.css) or they misalign.
- `page.getTextContent()` and `page.render()` are independent — run them concurrently with `Promise.all`.

### Annotation layer

Import `AnnotationLayer` from `pdfjs-dist`.

```js
const annotations = await page.getAnnotations();
const annotDiv = document.createElement("div");
annotDiv.className = "annotationLayer";
container.appendChild(annotDiv);
AnnotationLayer.render({
  viewport: viewport.clone({ dontFlip: true }),
  div: annotDiv,
  annotations,
  page,
  linkService,
  renderForms: true,
});
```

- **ALWAYS pass `viewport.clone({ dontFlip: true })`** — PDF Y-axis is bottom-up, CSS is top-down. The canvas flips internally; the annotation layer does its own flip via CSS. Without `dontFlip: true`, every annotation is mirrored vertically.
- `renderForms: true` makes Widget annotations (text inputs, checkboxes, dropdowns) into real HTML form elements.

### Link service (minimal implementation)

```js
const linkService = {
  async goToDestination(dest) {
    let destination =
      typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!destination) return;
    const pageIndex = await pdf.getPageIndex(destination[0]);
    scrollToPage(pageIndex + 1); // getPageIndex is 0-based
  },
  goToPage(n) {
    scrollToPage(n);
  },
  addLinkAttributes(el, url, newWindow) {
    el.href = url;
    el.target = newWindow ? "_blank" : "_self";
    el.rel = "noopener noreferrer";
  },
  get page() {
    return 1;
  },
  set page(_) {},
  getDestinationHash() {
    return "#";
  },
  getAnchorUrl() {
    return "#";
  },
  isPageVisible() {
    return true;
  },
  isPageCached() {
    return false;
  },
  eventBus: null,
};
```

## Multi-page layout

Stack all pages vertically in a scroll container. Each page gets a wrapper div with `data-page-number`:

```html
<div class="scroll-container" style="overflow-y: auto;">
  <div data-page-number="1" style="position: relative; margin-bottom: 12px;">
    <canvas>
      <div class="textLayer">
        <div class="annotationLayer"></div>
        <!-- ... more pages ... -->
      </div></canvas
    >
  </div>
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
- On zoom change: invalidate canvas cache, cancel renders, resize all page wrappers, re-render only visible pages (let IntersectionObserver handle it).

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
- Resizing canvas after `render()` — erases the drawing
- Using `getPage(0)` — pages are 1-indexed
- Missing `position: relative` on page wrapper — text and annotation layers misalign
- Missing `dontFlip: true` for annotation viewport — annotations are vertically mirrored
- Two concurrent renders on the same canvas without canceling — corrupted output
- Rendering all pages eagerly on a 100+ page document — browser runs out of memory

## File structure

```
root/
├── CLAUDE.md
└── src/
    ├── main.js            # entry point, file input handling
    ├── pdfLoader.js       # getDocument + worker setup
    ├── pageRenderer.js    # canvas + text + annotation rendering
    ├── lazyManager.js     # IntersectionObserver + page state machine
    ├── renderCache.js     # LRU canvas cache
    ├── navigation.js      # prev/next, page input, scroll detection
    ├── search.js          # text layer search + highlighting
    ├── linkService.js     # minimal link service for annotations
    ├── thumbnails.js      # sidebar thumbnail rendering (scale ~0.2)
    └── styles/
        └── viewer.css     # viewer styles (import pdf_viewer.css here)
└── demo/                  # contains index.html, demo app and sample pdf for testing
```

## Build targets

| Asset              | Target gzip size |
| ------------------ | ---------------- |
| pdf.min.mjs        | ~400KB           |
| pdf.worker.min.mjs | ~550KB           |
| Viewer code        | <50KB            |
