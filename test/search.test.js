import { describe, it, expect, vi, beforeEach } from "vitest";
import { PdfSearch } from "../src/search.js";

// A fake PageRenderer for search: its textDiv holds one <span> per string, and
// streamTextContent() yields one text item per string so the per-page match
// counts line up with the marks applyToPage produces.
function makeRenderer(strings, { isRendered = true } = {}) {
  const textDiv = document.createElement("div");
  for (const s of strings) {
    const span = document.createElement("span");
    span.textContent = s;
    textDiv.appendChild(span);
  }
  const items = strings.map((str) => ({ str }));
  const wrapper = document.createElement("div");
  const pr = {
    isRendered,
    textDiv,
    wrapper,
    page: {
      streamTextContent: vi.fn(() => {
        let emitted = false;
        return {
          getReader: () => ({
            read: () => {
              if (emitted) return Promise.resolve({ done: true, value: undefined });
              emitted = true;
              return Promise.resolve({ done: false, value: { items } });
            },
            releaseLock: vi.fn(),
          }),
        };
      }),
    },
    render: vi.fn(() => {
      pr.isRendered = true;
      return Promise.resolve();
    }),
  };
  return pr;
}

const marks = (pr) => pr.textDiv.querySelectorAll("mark");

beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.scrollIntoView.mockClear?.();
});

describe("PdfSearch.search()", () => {
  it("wraps matches in <mark> and reports the total via onUpdate", async () => {
    const onUpdate = vi.fn();
    const pr = makeRenderer(["foo bar foo"]);
    const search = new PdfSearch([pr], { onUpdate });

    await search.search("foo");

    expect(marks(pr)).toHaveLength(2);
    // current index starts at 0 -> reported as 1 / 2
    expect(onUpdate).toHaveBeenLastCalledWith(1, 2);
    // the first mark is the current one
    expect(pr.textDiv.querySelector('mark[data-match-index="0"]')).toBeTruthy();
  });

  it("clears marks and reports (0,0) for an empty query", async () => {
    const onUpdate = vi.fn();
    const pr = makeRenderer(["foo foo"]);
    const search = new PdfSearch([pr], { onUpdate });

    await search.search("foo");
    expect(marks(pr)).toHaveLength(2);

    await search.search("");
    expect(marks(pr)).toHaveLength(0);
    expect(onUpdate).toHaveBeenLastCalledWith(0, 0);
  });

  it("honors matchCase", async () => {
    const sensitive = makeRenderer(["Foo foo"]);
    await new PdfSearch([sensitive]).search("foo", { matchCase: true });
    expect(marks(sensitive)).toHaveLength(1);

    const insensitive = makeRenderer(["Foo foo"]);
    await new PdfSearch([insensitive]).search("foo", { matchCase: false });
    expect(marks(insensitive)).toHaveLength(2);
  });

  it("honors wholeWord", async () => {
    const pr = makeRenderer(["foo foobar foo"]);
    await new PdfSearch([pr]).search("foo", { wholeWord: true });
    expect(marks(pr)).toHaveLength(2); // the two standalone "foo", not "foobar"
  });

  it("treats the query as a literal (regex-escaped)", async () => {
    const pr = makeRenderer(["a.b axb"]);
    await new PdfSearch([pr]).search("a.b");
    expect(marks(pr)).toHaveLength(1); // only the literal "a.b"
  });

  it("reports (0,0) when nothing matches", async () => {
    const onUpdate = vi.fn();
    const pr = makeRenderer(["nothing here"]);
    await new PdfSearch([pr], { onUpdate }).search("zzz");
    expect(marks(pr)).toHaveLength(0);
    expect(onUpdate).toHaveBeenLastCalledWith(0, 0);
  });

  it("indexes matches continuously across pages", async () => {
    const onUpdate = vi.fn();
    const p1 = makeRenderer(["foo"]);
    const p2 = makeRenderer(["foo foo"]);
    const search = new PdfSearch([p1, p2], { onUpdate });

    await search.search("foo");
    expect(onUpdate).toHaveBeenLastCalledWith(1, 3);
    // page 2's first match carries the global index 1
    expect(p2.textDiv.querySelector('mark[data-match-index="1"]')).toBeTruthy();
    expect(p2.textDiv.querySelector('mark[data-match-index="2"]')).toBeTruthy();
  });
});

describe("PdfSearch match navigation", () => {
  it("nextMatch / prevMatch advance and wrap with continuous reporting", async () => {
    const onUpdate = vi.fn();
    const search = new PdfSearch([makeRenderer(["foo foo foo"])], { onUpdate });
    await search.search("foo"); // current = 0 -> (1,3)

    await search.nextMatch();
    expect(onUpdate).toHaveBeenLastCalledWith(2, 3);

    await search.prevMatch();
    await search.prevMatch(); // 1 -> 0 -> wrap to 2
    expect(onUpdate).toHaveBeenLastCalledWith(3, 3);
  });

  it("renders and marks a not-yet-rendered target page on navigation", async () => {
    const p1 = makeRenderer(["foo"]);
    const p2 = makeRenderer(["foo"], { isRendered: false });
    const search = new PdfSearch([p1, p2]);

    await search.search("foo"); // marks p1 (rendered); p2 not marked yet
    expect(marks(p2)).toHaveLength(0);

    await search.nextMatch(); // -> index 1 lives on p2
    expect(p2.render).toHaveBeenCalled();
    expect(marks(p2)).toHaveLength(1);
  });

  it("nextMatch is a no-op when there are no matches", async () => {
    const search = new PdfSearch([makeRenderer(["foo"])]);
    await search.search("zzz");
    await expect(search.nextMatch()).resolves.toBeUndefined();
  });
});

describe("PdfSearch.applyToPage()", () => {
  it("is idempotent — re-marking a page does not double-wrap", async () => {
    const pr = makeRenderer(["foo foo"]);
    const search = new PdfSearch([pr]);
    await search.search("foo");
    expect(marks(pr)).toHaveLength(2);

    search.applyToPage(pr); // walker skips text nodes already inside <mark>
    expect(marks(pr)).toHaveLength(2);
  });

  it("does nothing when there is no active query", () => {
    const pr = makeRenderer(["foo"]);
    const search = new PdfSearch([pr]);
    search.applyToPage(pr);
    expect(marks(pr)).toHaveLength(0);
  });
});

describe("mark styling", () => {
  it("highlights the current match with an opaque style and reverts it on navigation", async () => {
    const pr = makeRenderer(["foo foo"]);
    const search = new PdfSearch([pr]);
    await search.search("foo"); // current = index 0

    const [m0, m1] = Array.from(pr.textDiv.querySelectorAll("mark"));
    // Current match: opaque gold (#ffd54a → rgb)
    expect(m0.style.backgroundColor).toBe("rgb(255, 213, 74)");
    // Non-current: translucent tint
    expect(m1.style.backgroundColor).toBe("rgba(255, 213, 74, 0.45)");

    await search.nextMatch(); // current moves to index 1
    expect(m0.style.backgroundColor).toBe("rgba(255, 213, 74, 0.45)"); // reverted
    expect(m1.style.backgroundColor).toBe("rgb(255, 213, 74)");        // now current
  });
});

describe("PdfSearch.setScrollBehavior()", () => {
  it("uses the configured behavior when scrolling to a match", async () => {
    const search = new PdfSearch([makeRenderer(["foo foo"])]);
    search.setScrollBehavior("instant");
    await search.search("foo");
    await search.nextMatch();

    const calls = Element.prototype.scrollIntoView.mock.calls;
    expect(calls.at(-1)[0]).toMatchObject({ behavior: "instant" });
  });

  it("falls back to smooth for unknown values", async () => {
    const search = new PdfSearch([makeRenderer(["foo foo"])]);
    search.setScrollBehavior("bogus");
    await search.search("foo");
    await search.nextMatch();

    const calls = Element.prototype.scrollIntoView.mock.calls;
    expect(calls.at(-1)[0]).toMatchObject({ behavior: "smooth" });
  });
});

describe("PdfSearch.destroy()", () => {
  it("clears marks and drops the renderer references", async () => {
    const pr = makeRenderer(["foo foo"]);
    const search = new PdfSearch([pr]);
    await search.search("foo");
    expect(marks(pr)).toHaveLength(2);

    search.destroy();
    expect(marks(pr)).toHaveLength(0);
    expect(search.renderers).toEqual([]);
  });
});
