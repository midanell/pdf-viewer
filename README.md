# pdf-viewer

A lightweight, framework-free PDF viewer built on [Mozilla PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist` v6). Drop a host element onto the page, call `load()`, and get a fully functional viewer with text selection, annotations, search, thumbnails, zoom, and rotation — all with no React, Vue, or other framework required.

## Features

- Multi-page lazy rendering — only pages near the viewport are rendered
- Text layer with full text selection and copy
- Annotation layer with live hyperlinks and form fields
- Full-text search (match case, whole word) with match navigation
- Thumbnail sidebar with lazy rendering
- Zoom (fit-to-width or explicit scale), rotation, keyboard shortcuts
- Retina / high-DPI support
- Built-in loading overlay (indeterminate → determinate progress bar)
- Configurable page ordering and page filtering
- Responsive toolbar that collapses to a compact mode on narrow viewports

## Installation

```
npm install pdfjs-dist
```

Copy the `src/` directory into your project. The viewer is plain ES modules with no build step required — serve it directly or bundle it with any tool that supports ES modules.

The viewer resolves all PDF.js assets (CMaps, standard fonts, WebAssembly image decoders, ICC profiles) from `node_modules/pdfjs-dist` automatically via `import.meta.url`. No extra configuration is needed as long as `node_modules` is reachable from the server root.

## Quick start

The text layer requires the PDF.js stylesheet for correct font sizing and span alignment. Add it to your HTML:

```html
<link rel="stylesheet" href="/node_modules/pdfjs-dist/web/pdf_viewer.css" />
```

Then mount the viewer:

```html
<div id="pdf-host" style="width: 800px; height: 600px;"></div>

<script type="module">
  import { PdfViewer } from "./src/viewer.js";

  const viewer = new PdfViewer(document.getElementById("pdf-host"));
  await viewer.load("/path/to/document.pdf");
</script>
```

The host element must have a **definite, bounded height** — a fixed height, `100vh`, or `height: 100%` where **every ancestor up to a fixed-height element also has a definite height**. The viewer fills the host entirely and handles its own internal layout, including scrolling.

Two requirements are easy to miss:

- **A `max-height` is not enough.** `height: 100%` does not resolve against an ancestor that only sets `max-height` — the host falls back to content height, grows to fit every page, and the toolbar scrolls out of view along with the pages.
- **Do not put `overflow` / `overflow-y` on the host or any container around it.** The viewer installs its own internal scroll region and pins the toolbar above it. An outer scroller competes with that region and is what physically scrolls the toolbar off-screen.

### Troubleshooting

- **Toolbar scrolls away with the pages / becomes unreachable** — the host's height is not bounded (often a `max-height` instead of a definite `height`, or an ancestor without a definite height), and/or a container around the host has its own `overflow-y: auto`. Give the host a definite height chain and remove the outer `overflow`. To confirm the diagnosis, temporarily set the host to a hard `height: 600px`; if the toolbar then pins correctly, the height chain was the problem.

## API

### `new PdfViewer(host, options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `sizing` | `"fit-width"` \| `"fit-page"` \| `"explicit"` | `"fit-width"` | Zoom mode on load. `"fit-page"` fits each page's height to the viewport |
| `scale` | `number` | `1.5` | Initial scale when `sizing` is `"explicit"` |
| `zoomControls` | `boolean` | `true` | Whether to render the built-in toolbar |
| `useCustomProgress` | `boolean` | `false` | Suppress the built-in loading overlay |
| `pageOrder` | `number[]` | `[]` | Pages to promote to the front, in order |
| `hideUnorderedPages` | `boolean` | `false` | Show only pages listed in `pageOrder` |
| `margin` | `string` | `"12px"` | CSS length for vertical spacing around pages (top of the first page + bottom of every page) |
| `scrollBehavior` | `"smooth"` \| `"instant"` | `"smooth"` | Scroll animation for next/prev page and next/prev search match navigation. `"instant"` jumps without animating. Changeable at runtime via `viewer.setScrollBehavior(...)`. |

### `viewer.load(url, options?)`

Loads a PDF from a URL string, `Uint8Array`, or any value accepted by `pdfjsLib.getDocument()`. Returns a promise that resolves when the first page is rendered and all pages have placeholders.

| Option | Type | Description |
|---|---|---|
| `onProgress` | `({ loaded, total }) => void` | Progress callback when `useCustomProgress` is `true` |

### Navigation

```js
viewer.goToPage(n)       // 1-indexed; clamps to valid range
viewer.getCurrentPage()  // returns current visible page number
viewer.getPageCount()    // total number of visible pages (respects pageOrder)
```

### Zoom

```js
viewer.setZoom("fit-width")  // fit page width to container width
viewer.setZoom("fit-page")   // fit page height to the viewport
viewer.setZoom(1.5)          // explicit scale (72 DPI baseline)
viewer.zoomIn()              // step through ZOOM_STEPS
viewer.zoomOut()
viewer.getZoom()             // { mode, scale }
```

Ctrl/Cmd+scroll also triggers zoom, as do the keyboard shortcuts `Ctrl/Cmd` + `+` / `=` (zoom in) and `Ctrl/Cmd` + `-` (zoom out) while the viewer is focused.

### Rotation

```js
viewer.rotateClockwise()        // +90°
viewer.rotateCounterclockwise() // −90°
viewer.getRotation()            // 0 | 90 | 180 | 270
```

### Search

```js
viewer.search("query", { matchCase: false, wholeWord: false })
viewer.nextMatch()
viewer.prevMatch()
```

### Page ordering

```js
viewer.setPageOrder([3, 1, 2], { hideUnordered: false })
```

Promotes pages 3, 1, 2 to the front; remaining pages follow in natural order unless `hideUnordered` is `true`.

### Thumbnails

```js
viewer.toggleThumbnails()  // show/hide the sidebar
```

### Teardown

```js
await viewer.destroy()  // cancels all renders, frees memory, removes DOM
```

## Architecture

### Module overview

| Module | Responsibility |
|---|---|
| `viewer.js` | Top-level `PdfViewer` class — orchestrates all subsystems |
| `pageRenderer.js` | Per-page canvas + text + annotation rendering |
| `worker.js` | Sets `GlobalWorkerOptions.workerSrc` at import time; exports `PDF_ASSET_URLS` (cMaps, fonts, wasm, icc) |
| `toolbar.js` | Imperative toolbar DOM with compact/full responsive layouts |
| `search.js` | Full-text search over text layer spans |
| `thumbnails.js` | Lazily rendered thumbnail sidebar |
| `loading.js` | Loading overlay (indeterminate and progress modes) |
| `linkService.js` | Minimal PDF.js link service adapter for annotation navigation |

### Three-layer page rendering

Every page renders three stacked layers inside a `position: relative` wrapper:

1. **Canvas** — pixel-accurate bitmap via `page.render()`, sized in physical pixels for retina (`canvas.width = cssWidth * dpr`) with the DPR scale passed as the `transform` parameter to `page.render()`.
2. **Text layer** — transparent `<span>` elements positioned over the canvas for text selection and search highlighting. Two CSS variables, `--scale-factor` and `--total-scale-factor`, are kept in sync on the wrapper so PDF.js text-layer CSS sizes fonts correctly (v6 switched from the former to the latter for font sizing).
3. **Annotation layer** — hyperlinks, form widgets, and other interactive elements. The viewport is cloned with `dontFlip: true` so the annotation layer performs its own Y-axis flip independently of the canvas.

All three layers share the same `viewport` object, ensuring pixel-perfect alignment.

### Lazy rendering with three IntersectionObservers

`PdfViewer` uses three concurrent observers, each with a different viewport margin:

| Observer | Margin | Action |
|---|---|---|
| Lazy render | `200px` | Renders pages before they enter view |
| Discard | `1500px` | Discards canvases far outside the viewport to reclaim GPU memory |
| Page tracker | `0px`, multi-threshold | Tracks which page has the highest intersection ratio to update the toolbar page indicator |

Page wrappers are sized with `setSize()` at startup so the scrollbar reflects the full document length before any page is rendered.

### Render cancellation

`RenderTask.cancel()` is asynchronous — it rejects the task's promise with `RenderingCancelledException`. `PageRenderer` always awaits the rejection before starting a new render on the same canvas to prevent two renders racing and corrupting each other. The same pattern applies to `TextLayer.cancel()`.

### Scroll anchoring on zoom and rotation

When the scale or rotation changes, `PdfViewer` captures a scroll anchor before re-rendering (the first page whose bottom edge is below the viewport top, plus its fractional offset) and restores it afterward. This keeps the reading position stable across zoom changes.

### Programmatic scroll suppression

`goToPage()` sets a `_scrollingTo` flag for 600 ms. The page-tracker `IntersectionObserver` ignores observer callbacks during this window to avoid feedback loops where programmatic scrolling races with observer-driven page updates.

### Toolbar responsive layout

`PdfToolbar` observes its own width with `ResizeObserver`. Below 600 px it switches to compact mode: each toolbar group hides non-essential controls into a `...` dropdown, keeping the toolbar functional on narrow screens without wrapping.

### Search implementation

`PdfSearch` operates entirely on the text layer DOM — no PDF.js `PDFFindController` dependency. It walks text nodes with `TreeWalker`, wraps matches in `<mark>` elements, and maintains a global match index across all pages. If the target page has not been rendered yet, it forces a render before applying highlights.

## Demo

The `demo/` directory contains a single-page app that loads a sample PDF and demonstrates page reordering. Run it with any static file server:

```
npm run dev
```

## Browser requirements

Requires a browser that supports ES modules, `IntersectionObserver`, `ResizeObserver`, and the Web Animations API — all baseline-available in current evergreen browsers.
