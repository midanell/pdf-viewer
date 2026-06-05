import { GlobalWorkerOptions } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).href;

// v6 moved image decoders (JPEG2000/JBIG2) and ICC color to WebAssembly and
// added wasmUrl + iccUrl alongside cMapUrl/standardFontDataUrl. When an asset
// is needed but its URL is unset, getDocument throws. Resolve all four from the
// local node_modules so the worker can fetch them (trailing slashes required).
const asset = (path) =>
  new URL(`../node_modules/pdfjs-dist/${path}`, import.meta.url).href;

export const PDF_ASSET_URLS = {
  cMapUrl: asset("cmaps/"),
  cMapPacked: true,
  standardFontDataUrl: asset("standard_fonts/"),
  wasmUrl: asset("wasm/"),
  iccUrl: asset("iccs/"),
};
