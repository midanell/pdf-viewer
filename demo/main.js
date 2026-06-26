import { PdfViewer } from "../src/viewer.js";

// ── Option helpers ────────────────────────────────────────────────────────────

function parsePageOrder() {
  return document
    .getElementById("opt-page-order")
    .value.split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function getOpts() {
  const pageOrder = parsePageOrder();

  return {
    cacheFullPdf: document.getElementById("opt-cache").checked,
    sizing: document.querySelector('input[name="sizing"]:checked').value,
    scrollBehavior: document.querySelector('input[name="scroll"]:checked').value,
    zoomControls: document.getElementById("opt-zoom-ctrl").checked,
    pageOrder,
    hideUnorderedPages: document.getElementById("opt-hide-unordered").checked,
    nativeTextSelection: document.getElementById("opt-native-sel").checked,
    // Seed the rebuilt viewer with whatever highlights are currently active,
    // so they survive option changes (exercises the constructor path too).
    customAnnotations: annotations,
  };
}

// ── Viewer lifecycle ──────────────────────────────────────────────────────────

const host = document.getElementById("pdf-host");
let viewer = null;
let rebuilding = false;
let annotations = [];

async function rebuild() {
  if (rebuilding) return;
  rebuilding = true;
  try {
    if (viewer) {
      await viewer.destroy();
      viewer = null;
    }

    const opts = getOpts();
    viewer = new PdfViewer(host, opts);
    const pdfParam = new URLSearchParams(location.search).get("pdf") ?? "sample.pdf";
    await viewer.load(`./${pdfParam}`);
    window.viewer = viewer;
  } finally {
    rebuilding = false;
  }
}

// ── Wire controls ─────────────────────────────────────────────────────────────

// Constructor-only options (they change how the viewer is built) trigger a full
// rebuild. Page ordering is applied live via the public setPageOrder() setter —
// no reload needed — see applyPageOrder() below.
const rebuildInputs = ["opt-cache", "opt-zoom-ctrl", "opt-native-sel"];
for (const id of rebuildInputs) {
  document.getElementById(id).addEventListener("change", rebuild);
}
for (const el of document.querySelectorAll('input[name="sizing"]')) {
  el.addEventListener("change", rebuild);
}
for (const el of document.querySelectorAll('input[name="scroll"]')) {
  el.addEventListener("change", rebuild);
}

// Apply the current page-order input + "hide unordered" flag live, without
// reloading the PDF, via the public setter.
function applyPageOrder() {
  if (!viewer?.pdf) return;
  const hideUnordered = document.getElementById("opt-hide-unordered").checked;
  return viewer.setPageOrder(parsePageOrder(), { hideUnordered });
}

// Page order: apply on Enter or when focus leaves the input.
const pageOrderInput = document.getElementById("opt-page-order");
pageOrderInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    applyPageOrder();
  }
});
pageOrderInput.addEventListener("blur", applyPageOrder);
document
  .getElementById("opt-hide-unordered")
  .addEventListener("change", applyPageOrder);

// Random page order: pick up to 10 unique pages (capped at the document's
// page count) in random order, then apply them live.
function randomPageOrder() {
  const total = viewer?.pdf?.numPages ?? 10;
  const count = Math.min(10, total, 1 + Math.floor(Math.random() * 10));
  const pages = Array.from({ length: total }, (_, i) => i + 1);
  for (let i = pages.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pages[i], pages[j]] = [pages[j], pages[i]];
  }
  return pages.slice(0, count);
}

document.getElementById("opt-page-order-rand").addEventListener("click", () => {
  pageOrderInput.value = randomPageOrder().join(",");
  applyPageOrder();
});

// ── Custom annotations ────────────────────────────────────────────────────────

const ANNO_COLORS = ["#ffd54a", "#4a9eff", "#ff5a7a", "#5ad17a", "#c77dff"];

// A random highlight box (normalized 0–1 PDF coords) on the given PDF page.
function randomAnnotation(page) {
  const width = 0.2 + Math.random() * 0.3; // 0.20 – 0.50 of page width
  const height = 0.03 + Math.random() * 0.07; // 0.03 – 0.10 of page height
  return {
    page,
    x: Math.random() * (1 - width),
    y: Math.random() * (1 - height),
    width,
    height,
    color: ANNO_COLORS[Math.floor(Math.random() * ANNO_COLORS.length)],
    opacity: 0.4,
  };
}

document.getElementById("anno-add").addEventListener("click", () => {
  if (!viewer?.pdf) return;
  // Target the PDF page currently in view so the new highlight is visible.
  const visible = viewer.getCurrentPage();
  const page = viewer.renderers[visible - 1]?.pageNumber ?? 1;
  annotations = [...annotations, randomAnnotation(page)];
  viewer.setCustomAnnotations(annotations);
});

document.getElementById("anno-clear").addEventListener("click", () => {
  annotations = [];
  viewer?.setCustomAnnotations(annotations);
});

// ── Divider drag ──────────────────────────────────────────────────────────────

const divider = document.getElementById("divider");
const main = document.getElementById("main");

divider.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  divider.classList.add("dragging");
  divider.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const available = document.body.clientWidth - 6;
    const mainWidth = Math.min(
      Math.max(available - ev.clientX, 300),
      available - 180,
    );
    main.style.width = `${mainWidth}px`;
  };

  const onUp = () => {
    divider.classList.remove("dragging");
    divider.removeEventListener("pointermove", onMove);
    divider.removeEventListener("pointerup", onUp);
  };

  divider.addEventListener("pointermove", onMove);
  divider.addEventListener("pointerup", onUp);
});

// ── Viewer toggle ─────────────────────────────────────────────────────────────

const mozillaFrame = document.getElementById("mozilla-frame");
const toggleBtn = document.getElementById("viewer-toggle");

// Activate the Mozilla prebuilt viewer exclusively: destroy the custom viewer
// and load viewer.html in the iframe. The iframe src is set fresh each time so
// a clean load is used (useful for perf measurements).
function enterMozillaMode() {
  if (viewer) {
    viewer.destroy();
    viewer = null;
  }
  rebuilding = false;
  host.hidden = true;
  host.style.display = "none";

  const base = new URL("./", location.href);
  const viewerUrl = new URL("pdfjs-6.0.227-dist/web/viewer", base);
  // Source - https://stackoverflow.com/a/18750001
  // Posted by Chris Baker, modified by community. See post 'Timeline' for change history
  // Retrieved 2026-06-23, License - CC BY-SA 4.0

  const pdfParam =
    new URLSearchParams(location.search).get("pdf") ?? "sample.pdf";
  const encodedStr = encodeStr(new URL(pdfParam, base).href);
  viewerUrl.searchParams.set("file", encodedStr);
  mozillaFrame.src = viewerUrl.href;
  mozillaFrame.hidden = false;
  console.log(mozillaFrame.src);

  toggleBtn.textContent = "Switch to Custom";
  history.replaceState(null, "", "?pdf_mode=mozilla");
}

// Activate the custom viewer exclusively: unload the iframe and rebuild.
function enterCustomMode() {
  mozillaFrame.src = "";
  mozillaFrame.hidden = true;
  host.hidden = false;
  host.style.display = "";

  toggleBtn.textContent = "Switch to Mozilla";
  history.replaceState(null, "", "?pdf_mode=custom");
  rebuild();
}

toggleBtn.addEventListener("click", () => {
  if (mozillaFrame.hidden) {
    enterMozillaMode();
  } else {
    enterCustomMode();
  }
});

// ── URL param sync ────────────────────────────────────────────────────────────

function setUrlParam(key, value) {
  const url = new URL(location.href);
  url.searchParams.set(key, value);
  history.replaceState(null, "", url.search);
}

// Sync full_pdf_cache param ↔ opt-cache checkbox (read before initial rebuild)
const cacheCheckbox = document.getElementById("opt-cache");
const initCache = new URLSearchParams(location.search).get("full_pdf_cache");
if (initCache === "on") cacheCheckbox.checked = true;
else if (initCache === "off") cacheCheckbox.checked = false;

cacheCheckbox.addEventListener("change", () => {
  setUrlParam("full_pdf_cache", cacheCheckbox.checked ? "on" : "off");
});

// ── Initial load ──────────────────────────────────────────────────────────────

if (new URLSearchParams(location.search).get("pdf_mode") === "mozilla") {
  enterMozillaMode();
} else {
  rebuild();
}

function encodeStr(str) {
  return str.replace(
    /[\u00A0-\u9999<>\&]/g,
    (i) => "&#" + i.charCodeAt(0) + ";",
  );
}
