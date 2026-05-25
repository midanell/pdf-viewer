import { GlobalWorkerOptions } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).href;
