export class PageRenderer {
  constructor(pdf, pageNumber) {
    this.pdf = pdf;
    this.pageNumber = pageNumber;
    this.page = null;
    this.wrapper = document.createElement("div");
    this.wrapper.dataset.pageNumber = String(pageNumber);
    this.wrapper.style.position = "relative";
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.wrapper.appendChild(this.canvas);
    this._task = null;
  }

  async render({ scale = 1.5 } = {}) {
    if (!this.page) this.page = await this.pdf.getPage(this.pageNumber);
    await this._cancelActive();

    const viewport = this.page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.floor(viewport.width);
    const cssH = Math.floor(viewport.height);

    this.canvas.width = Math.floor(viewport.width * dpr);
    this.canvas.height = Math.floor(viewport.height * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.wrapper.style.width = `${cssW}px`;
    this.wrapper.style.height = `${cssH}px`;

    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this._task = this.page.render({ canvasContext: ctx, viewport });
    try {
      await this._task.promise;
    } finally {
      this._task = null;
    }
  }

  async cancel() {
    await this._cancelActive();
  }

  async _cancelActive() {
    if (!this._task) return;
    const task = this._task;
    task.cancel();
    try {
      await task.promise;
    } catch (e) {
      if (e?.name !== "RenderingCancelledException") throw e;
    }
  }
}
