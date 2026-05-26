import { PdfViewer } from "../src/viewer.js";

const host = document.getElementById("pdf-host");
const viewer = new PdfViewer(host);

const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const loadingFill = document.getElementById("loading-fill");

await viewer.load("./sample.pdf", {
  onProgress: ({ loaded, total }) => {
    if (total > 0) {
      loading.classList.remove("indeterminate");
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      loadingText.textContent = `Loading ${pct}%`;
      loadingFill.style.width = `${pct}%`;
    } else {
      loading.classList.add("indeterminate");
      loadingText.textContent = "Loading…";
    }
  },
});
loading.classList.add("hidden");

// Divider drag — demo only, not part of the viewer library
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
      available - 150,
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
