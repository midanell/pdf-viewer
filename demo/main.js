import { PdfViewer } from "../src/viewer.js";

const host = document.getElementById("pdf-host");
const viewer = new PdfViewer(host);
await viewer.load("./sample.pdf");

// Divider drag — demo only, not part of the viewer library
const divider = document.getElementById("divider");

divider.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  divider.classList.add("dragging");
  divider.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const sidebarPx = Math.min(Math.max(ev.clientX, 150), 600);
    document.body.style.gridTemplateColumns = `${sidebarPx}px 6px 1fr`;
  };

  const onUp = () => {
    divider.classList.remove("dragging");
    divider.removeEventListener("pointermove", onMove);
    divider.removeEventListener("pointerup", onUp);
  };

  divider.addEventListener("pointermove", onMove);
  divider.addEventListener("pointerup", onUp);
});
