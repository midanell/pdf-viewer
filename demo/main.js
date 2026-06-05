import { PdfViewer } from "../src/viewer.js";

// ── Option helpers ────────────────────────────────────────────────────────────

function getOpts() {
  const pageOrderRaw = document.getElementById("opt-page-order").value;
  const pageOrder = pageOrderRaw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  return {
    cacheFullPdf: document.getElementById("opt-cache").checked,
    sizing: document.querySelector('input[name="sizing"]:checked').value,
    scrollBehavior: document.querySelector('input[name="scroll"]:checked').value,
    zoomControls: document.getElementById("opt-zoom-ctrl").checked,
    pageOrder,
    hideUnorderedPages: document.getElementById("opt-hide-unordered").checked,
    nativeTextSelection: document.getElementById("opt-native-sel").checked,
  };
}

// ── Viewer lifecycle ──────────────────────────────────────────────────────────

const host = document.getElementById("pdf-host");
let viewer = null;
let rebuilding = false;

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
    await viewer.load("./sample.pdf");
    window.viewer = viewer;
  } finally {
    rebuilding = false;
  }
}

// ── Wire controls ─────────────────────────────────────────────────────────────

// All controls trigger a full rebuild so the effect of each option is
// immediately obvious. Controls that support runtime updates (scrollBehavior,
// pageOrder) could call viewer setters instead, but rebuilding keeps the demo
// code simple and makes the option's impact unambiguous.
const rebuildInputs = [
  "opt-cache",
  "opt-zoom-ctrl",
  "opt-hide-unordered",
  "opt-native-sel",
];
for (const id of rebuildInputs) {
  document.getElementById(id).addEventListener("change", rebuild);
}
for (const el of document.querySelectorAll('input[name="sizing"]')) {
  el.addEventListener("change", rebuild);
}
for (const el of document.querySelectorAll('input[name="scroll"]')) {
  el.addEventListener("change", rebuild);
}

// Page order: rebuild on Enter or when focus leaves the input
const pageOrderInput = document.getElementById("opt-page-order");
pageOrderInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); rebuild(); }
});
pageOrderInput.addEventListener("blur", rebuild);

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

// ── Initial load ──────────────────────────────────────────────────────────────

rebuild();
