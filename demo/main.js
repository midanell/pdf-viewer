import { PdfViewer } from "../src/viewer.js";

const canvas = document.getElementById("pdf-canvas");
const viewer = new PdfViewer(canvas);
await viewer.load("./sample.pdf");
