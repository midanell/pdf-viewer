import { PdfViewer } from "../src/viewer.js";

const host = document.getElementById("pdf-host");
const viewer = new PdfViewer(host);

await viewer.load("./sample.pdf");

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
