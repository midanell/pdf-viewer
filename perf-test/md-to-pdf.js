#!/usr/bin/env node
// Merge one or more Markdown files into a single PDF, in the given order.
// SVG/image references are resolved relative to each source file's directory and
// inlined, so the charts render correctly without a LaTeX/SVG toolchain.
//
// Usage: node md-to-pdf.js <output.pdf> <file1.md> [file2.md ...]

import { readFileSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
import { marked } from "marked";
import { chromium } from "playwright";

const [, , output, ...inputs] = process.argv;

if (!output || inputs.length === 0) {
  console.error("Usage: node md-to-pdf.js <output.pdf> <file1.md> [file2.md ...]");
  process.exit(1);
}

marked.setOptions({ gfm: true });

const MIME = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

// Replace local <img src="..."> with inline SVG or a data URI, resolved against baseDir.
function inlineImages(html, baseDir) {
  return html.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/g, (tag, src) => {
    if (/^(https?:|data:)/.test(src)) return tag; // leave remote/data URIs alone
    const file = resolve(baseDir, src);
    const ext = extname(src).toLowerCase();
    try {
      if (ext === ".svg") {
        // Inline the SVG markup directly so Chromium renders it natively.
        return readFileSync(file, "utf8");
      }
      const b64 = readFileSync(file).toString("base64");
      return tag.replace(src, `data:${MIME[ext] || "application/octet-stream"};base64,${b64}`);
    } catch {
      console.warn(`Warning: could not inline image "${src}" (looked in ${baseDir})`);
      return tag;
    }
  });
}

const sections = inputs
  .map((input) => {
    const md = readFileSync(input, "utf8");
    return inlineImages(marked.parse(md), dirname(resolve(input)));
  })
  .join('\n<div class="page-break"></div>\n');

const doc = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font: 14px/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; max-width: 820px; margin: 0 auto; padding: 0 8px; }
  h1, h2, h3 { line-height: 1.25; }
  h1 { font-size: 1.9em; border-bottom: 2px solid #ddd; padding-bottom: .25em; }
  h2 { font-size: 1.45em; border-bottom: 1px solid #eee; padding-bottom: .2em; margin-top: 1.6em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .92em; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
  th { background: #f5f5f5; }
  code { background: #f3f3f3; padding: .1em .35em; border-radius: 3px; font-size: .9em; }
  pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #d0d7de; margin: 1em 0; padding: .2em 1em; color: #555; background: #f9f9f9; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
  svg { max-width: 100%; height: auto; }
  img { max-width: 100%; }
  .page-break { page-break-before: always; }
</style></head><body>${sections}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(doc, { waitUntil: "networkidle" });
await page.pdf({
  path: output,
  format: "A4",
  margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
  printBackground: true,
});
await browser.close();
console.log(`Created: ${output}`);
