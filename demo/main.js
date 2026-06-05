import { PdfViewer } from "../src/viewer.js";

const host = document.getElementById("pdf-host");
const viewer = new PdfViewer(host, {
  pageOrder: [3, 4, 66, 55],
  hideUnorderedPages: false,
  customAnnotations: [
    // page omitted -> defaults to page 1; bottom-left origin, default color
    { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
    // page 3, custom color + opacity, near the top of the page
    {
      page: 3,
      x: 0.4,
      y: 0.8,
      width: 0.2,
      height: 0.1,
      color: "#4a9eff",
      opacity: 0.5,
    },
  ],
  scrollBehavior: "instant",
});

await viewer.load("./sample.pdf");

// Exposed so the runtime-update path can be exercised from the console:
//   viewer.setCustomAnnotations([{ page: 4, x: 0.2, y: 0.5, width: 0.4, height: 0.1 }])
window.viewer = viewer;

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
