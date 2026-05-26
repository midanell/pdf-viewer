const MARK_BG = "rgba(255,200,0,0.5)";
const MARK_BG_CURRENT = "rgba(255,140,0,0.85)";
const MARK_STYLE_BASE = "color: inherit; padding: 0; border-radius: 2px;";

export class PdfSearch {
  constructor(renderers, { onUpdate } = {}) {
    this.renderers = renderers;
    this._onUpdate = onUpdate;
    this._query = "";
    this._matchCase = false;
    this._wholeWord = false;
    this._pageCounts = [];
    this._pageStartIdx = [];
    this._total = 0;
    this._currentIdx = -1;
    this._currentMarkEl = null;
  }

  async search(query, { matchCase = false, wholeWord = false } = {}) {
    this._query = query ?? "";
    this._matchCase = matchCase;
    this._wholeWord = wholeWord;
    this._clearAllMarks();
    this._currentMarkEl = null;
    this._currentIdx = -1;
    this._total = 0;
    this._pageCounts = [];
    this._pageStartIdx = [];

    if (!this._query) {
      this._onUpdate?.(0, 0);
      return;
    }

    const counts = await Promise.all(
      this.renderers.map(async (pr) => {
        const tc = await pr.page.getTextContent();
        const text = tc.items.map((i) => i.str).join("");
        const re = this._buildRegex();
        const m = text.match(re);
        return m ? m.length : 0;
      })
    );

    let cursor = 0;
    for (let i = 0; i < counts.length; i++) {
      this._pageStartIdx[i] = cursor;
      cursor += counts[i];
    }
    this._pageCounts = counts;
    this._total = cursor;

    for (const pr of this.renderers) {
      if (pr.isRendered) this.applyToPage(pr);
    }

    if (this._total > 0) {
      this._currentIdx = 0;
      await this._scrollToCurrent();
    } else {
      this._onUpdate?.(0, 0);
    }
  }

  nextMatch() {
    return this._step(+1);
  }

  prevMatch() {
    return this._step(-1);
  }

  applyToPage(pr) {
    const div = pr.textDiv;
    if (!div || !this._query) return;
    const re = this._buildRegex();
    const pageIdx = pr.pageNumber - 1;
    const pageStart = this._pageStartIdx[pageIdx] ?? 0;
    let localIdx = 0;

    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentNode?.tagName === "MARK") continue;
      nodes.push(n);
    }

    for (const textNode of nodes) {
      const text = textNode.nodeValue;
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > lastIdx) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
        }
        const mark = document.createElement("mark");
        mark.textContent = m[0];
        const globalIdx = pageStart + localIdx;
        mark.dataset.matchIndex = String(globalIdx);
        const isCurrent = globalIdx === this._currentIdx;
        mark.style.cssText = `background-color: ${
          isCurrent ? MARK_BG_CURRENT : MARK_BG
        }; ${MARK_STYLE_BASE}`;
        if (isCurrent) this._currentMarkEl = mark;
        frag.appendChild(mark);
        lastIdx = re.lastIndex;
        localIdx++;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  destroy() {
    this._clearAllMarks();
    this._currentMarkEl = null;
    this.renderers = [];
  }

  _buildRegex() {
    const esc = this._query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = this._wholeWord ? `\\b${esc}\\b` : esc;
    const flags = this._matchCase ? "g" : "gi";
    return new RegExp(pattern, flags);
  }

  async _step(dir) {
    if (this._total === 0) return;
    this._currentIdx =
      (this._currentIdx + dir + this._total) % this._total;
    await this._scrollToCurrent();
  }

  async _scrollToCurrent() {
    const idx = this._currentIdx;
    if (idx < 0) return;
    const pageIdx = this._pageIdxForMatch(idx);
    const pr = this.renderers[pageIdx];
    if (!pr) return;

    if (!pr.isRendered) {
      pr.wrapper.scrollIntoView({ block: "start", behavior: "smooth" });
      await pr.render().catch(() => {});
      if (this._query) this.applyToPage(pr);
    }

    const mark = pr.textDiv?.querySelector(
      `mark[data-match-index="${idx}"]`
    );
    this._setCurrentMark(mark);
    mark?.scrollIntoView({ block: "center", behavior: "smooth" });
    this._onUpdate?.(idx + 1, this._total);
  }

  _pageIdxForMatch(globalIdx) {
    for (let i = this._pageStartIdx.length - 1; i >= 0; i--) {
      if (this._pageStartIdx[i] <= globalIdx && this._pageCounts[i] > 0) {
        return i;
      }
    }
    return 0;
  }

  _setCurrentMark(mark) {
    if (this._currentMarkEl && this._currentMarkEl !== mark) {
      this._currentMarkEl.style.backgroundColor = MARK_BG;
    }
    this._currentMarkEl = mark ?? null;
    if (mark) mark.style.backgroundColor = MARK_BG_CURRENT;
  }

  _clearAllMarks() {
    for (const pr of this.renderers) {
      const div = pr.textDiv;
      if (!div) continue;
      const marks = div.querySelectorAll("mark");
      for (const m of marks) {
        m.parentNode.replaceChild(document.createTextNode(m.textContent), m);
      }
      div.normalize();
    }
  }
}
