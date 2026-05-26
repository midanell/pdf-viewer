import { PdfViewer } from "../src/viewer.js";

const host = document.getElementById("pdf-host");
const viewer = new PdfViewer(host);
await viewer.load("./sample.pdf");
