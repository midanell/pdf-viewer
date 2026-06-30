// Non-current matches: translucent tint. Text stays transparent so the canvas
// glyphs (whatever their colour) show through — these are just locators.
const MARK_STYLE_BASE    = "padding: 0; border-radius: 1px;";
const MARK_STYLE         = `${MARK_STYLE_BASE} color: inherit; background-color: rgba(255,213,74,0.45);`;
// Current match: opaque fill + forced dark text. This makes the text layer's
// own copy of the glyph visible and the opaque fill hides the canvas text
// underneath, so the match reads on ANY background — light text on a dark page
// or dark text on a light page. A single blend mode (multiply/screen) can only
// fix one of those two cases, which is why we control both fg and bg here.
const MARK_STYLE_CURRENT = `${MARK_STYLE_BASE} color: #1a1a1a; background-color: #ffd54a;`;

export class PdfSearch {
  constructor(renderers, { onUpdate, scrollBehavior = "smooth" } = {}) {
    this.renderers = renderers;
    this._onUpdate = onUpdate;
    this._scrollBehavior = scrollBehavior === "instant" ? "instant" : "smooth";
    this._query = "";
    this._matchCase = false;
    this._wholeWord = false;
    this._pageCounts = [];
    this._pageStartIdx = [];
    this._total = 0;
    this._currentIdx = -1;
    this._currentMarkEl = null;
    // Keyed by renderer index. Text content is immutable for the document's
    // lifetime, so we fetch each page once and reuse across searches.
    this._textCache = new Map();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

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

    const re = this._buildRegex();
    const counts = await Promise.all(
      this.renderers.map((pr, i) => this._countPageMatches(pr, i, re)),
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

  setScrollBehavior(behavior) {
    this._scrollBehavior = behavior === "instant" ? "instant" : "smooth";
  }

  destroy() {
    this._clearAllMarks();
    this._currentMarkEl = null;
    this._textCache.clear();
    this.renderers = [];
  }

  // ── Page application ───────────────────────────────────────────────────────

  applyToPage(pr) {
    const div = pr.textDiv;
    if (!div || !this._query) return;

    const re = this._buildRegex();
    const pageIdx = this.renderers.indexOf(pr);
    if (pageIdx < 0) return;

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
      const wrapped = this._wrapMatchesInNode(textNode, re, pageStart + localIdx);
      localIdx += wrapped;
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

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
      pr.wrapper.scrollIntoView({ block: "start", behavior: this._scrollBehavior });
      await pr.render().catch(() => {});
      if (this._query) this.applyToPage(pr);
    }

    const mark = pr.textDiv?.querySelector(`mark[data-match-index="${idx}"]`);
    this._setCurrentMark(mark);
    mark?.scrollIntoView({ block: "center", behavior: this._scrollBehavior });
    this._onUpdate?.(idx + 1, this._total);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  // Returns a promise for the text item strings of one page. The value stored
  // in the cache is the Promise itself (not the resolved array) so that parallel
  // search() calls issued before the first one resolves share a single worker
  // fetch instead of each starting their own.
  _getTextItems(pr, index) {
    let cached = this._textCache.get(index);
    if (!cached) {
      // getTextContent() uses Symbol.asyncIterator which Safari < 16.4 lacks.
      // streamTextContent() + reader.read() is universally supported.
      cached = (async () => {
        const stream = pr.page.streamTextContent();
        const reader = stream.getReader();
        const strs = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const item of value.items) {
              if (item.str) strs.push(item.str);
            }
          }
        } finally {
          reader.releaseLock();
        }
        return strs;
      })();
      this._textCache.set(index, cached);
    }
    return cached;
  }

  async _countPageMatches(pr, index, re) {
    const items = await this._getTextItems(pr, index);
    // Count per-item so the total matches what applyToPage can actually highlight:
    // a match spanning two text items (two separate spans) is not highlightable.
    let count = 0;
    for (const str of items) {
      const m = str.match(re);
      if (m) count += m.length;
    }
    return count;
  }

  // Splits one text node around every regex match, replacing it with a fragment
  // of plain text nodes and <mark> elements. Returns the number of matches wrapped.
  _wrapMatchesInNode(textNode, re, globalStart) {
    const text = textNode.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) return 0;

    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let wrapped = 0;
    let m;

    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      }
      const mark = document.createElement("mark");
      mark.textContent = m[0];
      const globalIdx = globalStart + wrapped;
      mark.dataset.matchIndex = String(globalIdx);
      const isCurrent = globalIdx === this._currentIdx;
      mark.style.cssText = isCurrent ? MARK_STYLE_CURRENT : MARK_STYLE;
      if (isCurrent) this._currentMarkEl = mark;
      frag.appendChild(mark);
      lastIdx = re.lastIndex;
      wrapped++;
      if (m.index === re.lastIndex) re.lastIndex++;
    }

    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
    textNode.parentNode.replaceChild(frag, textNode);
    return wrapped;
  }

  _buildRegex() {
    const esc = this._query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = this._wholeWord ? `\\b${esc}\\b` : esc;
    const flags = this._matchCase ? "g" : "gi";
    return new RegExp(pattern, flags);
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
      this._currentMarkEl.style.cssText = MARK_STYLE;
    }
    this._currentMarkEl = mark ?? null;
    if (mark) mark.style.cssText = MARK_STYLE_CURRENT;
  }

  _clearAllMarks() {
    for (const pr of this.renderers) {
      const div = pr.textDiv;
      if (!div) continue;
      for (const m of div.querySelectorAll("mark")) {
        m.parentNode.replaceChild(document.createTextNode(m.textContent), m);
      }
      div.normalize();
    }
  }
}
