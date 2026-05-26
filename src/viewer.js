import "./worker.js";
import * as pdfjsLib from "pdfjs-dist";
import { PageRenderer } from "./pageRenderer.js";

export class PdfViewer {
  constructor(host) {
    this.host = host;
    this.pdf = null;
    this.renderers = [];
  }

  async load(url) {
    this.pdf = await pdfjsLib.getDocument(url).promise;
    const pr = new PageRenderer(this.pdf, 1);
    this.host.appendChild(pr.wrapper);
    this.renderers.push(pr);
    await pr.render({ scale: 1.5 });
  }
}
