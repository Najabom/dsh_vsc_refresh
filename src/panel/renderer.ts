/**
 * Grafted markdown renderer — the SAME engine the official DSH web GUI uses.
 *
 * The harness's web UI renders message text with micromark (+ GFM extensions);
 * this module is that same pipeline, bundled into the panel at build time
 * (esbuild injects it into panel.html; CSP is script-src 'unsafe-inline').
 * Markdown SEMANTICS (what is a heading / table / fence / bold…) come from
 * micromark, so our output matches the official renderer by construction.
 *
 * What stays ours is the webview-specific SPACING: the panel body is
 * `white-space: pre-wrap`, so block elements (headings/tables/pre) separate by
 * their own margins and must NOT be followed by a bare "\n" (it would double
 * into a visible blank row), while text paragraphs separate by "\n\n" (one
 * visible blank line). The official page has no pre-wrap bodies, so this
 * layer has no official counterpart to copy.
 */
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/** Top-level block elements micromark can emit (p is special-cased). */
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "pre", "table", "ul", "ol", "blockquote", "hr",
]);

/* ------------------------------------------------------------------------- *
 * Autolink repair.
 *
 * GFM autolink literals (micromark) extend through every non-whitespace
 * character, so a literal URL directly followed by punctuation or text
 * (`https://a/；https://b/中文…`) becomes ONE <a> whose text runs on until the
 * next space — the whole sentence turns into a link. The official web UI
 * shows the same behavior; in the panel it makes entire messages unreadable.
 *
 * We post-process the micromark fragment:
 *  - anchors whose text equals their own href (autolinks only — explicit
 *    markdown links have a distinct text and stay untouched) are cut at the
 *    first BOUNDARY character (full-width/CJK punctuation or typographic
 *    punctuation), or at a CJK letter glued straight onto an ASCII
 *    alphanumeric (`/model比较` — prose, not a URL). CJK letters after URL
 *    structure (`/`, `.`, `-`, `:`…) are kept, so internationalized domains
 *    (`https://中文.中国/路径`) and IDN paths survive intact.
 *  - the cut-off remainder is re-scanned for bare URLs (same boundary set,
 *    GFM-style trailing punctuation trim) and re-wrapped as links, so
 *    `https://a；https://b` keeps two links.
 * ------------------------------------------------------------------------- */

/** Decode the HTML entities micromark emits in text/attribute content. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&amp;/g, "&");
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Punctuation that terminates an autolink (full-width + typographic). */
const BOUNDARY_CLASS =
  "\\u2014\\u2018\\u2019\\u201C\\u201D\\u2026\\u3000-\\u303F\\uFF01-\\uFF0F\\uFF1A-\\uFF20\\uFF3B-\\uFF40\\uFF5B-\\uFF65";
const BOUNDARY_RE = new RegExp(`[${BOUNDARY_CLASS}]`);

/** Bare URL in an autolink remainder (IDN letters allowed, boundaries stop). */
const BARE_URL_RE = new RegExp(`https?:\\/\\/[^\\s<>"'\`${BOUNDARY_CLASS}]+`, "gi");

/** CJK letters — allowed inside IDN hosts/paths, but not glued to ASCII ids. */
const CJK_LETTER_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/u;

/**
 * Index where an autolink must stop, or -1 when the whole run is a URL.
 * Stops at boundary punctuation; ALSO stops at a CJK letter glued directly to
 * an ASCII alphanumeric (`/model比较…`) — that is prose, not an IDN path.
 * CJK after URL structure (`/`, `.`, `-`, `:`, `?`…) stays: `https://中文.中国/路径`.
 */
function autolinkCut(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (BOUNDARY_RE.test(ch)) return i;
    if (CJK_LETTER_RE.test(ch)) {
      const prev = text.charAt(i - 1);
      if (!CJK_LETTER_RE.test(prev) && !/[/.:\-_?=&#+~%@|]/u.test(prev)) return i;
    }
  }
  return -1;
}

/** Wrap bare URLs in <a>; trailing punctuation stays outside the link. */
function linkifyUrls(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(BARE_URL_RE)) {
    const url = match[0];
    const cut = autolinkCut(url);
    const cutUrl = cut === -1 ? url : url.slice(0, cut);
    const trimmed = cutUrl.replace(/[.,;:!?'")\]}]+$/g, "");
    const index = match.index ?? 0;
    if (trimmed.length <= "https://".length) continue;
    let href = trimmed;
    try {
      href = encodeURI(trimmed);
    } catch {
      /* lone surrogate — keep the raw form */
    }
    out += escapeText(text.slice(last, index));
    out += `<a href="${escapeText(href)}">${escapeText(trimmed)}</a>`;
    out += escapeText(url.slice(trimmed.length));
    last = index + url.length;
  }
  return out + escapeText(text.slice(last));
}

const ANCHOR_RE = /<a href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g;

/** Cut over-extended autolinks at the first boundary character. */
function trimAutolinks(html: string): string {
  return html.replace(ANCHOR_RE, (whole: string, href: string, attrs: string, inner: string) => {
    if (inner.includes("<")) return whole; // markup inside (image/code), not plain text
    const rawHref = decodeEntities(href);
    let decodedHref = rawHref;
    try {
      decodedHref = decodeURI(rawHref);
    } catch {
      /* keep the raw form */
    }
    const text = decodeEntities(inner);
    if (text !== rawHref && text !== decodedHref) return whole; // explicit markdown link
    const cut = autolinkCut(text);
    if (cut <= 0) return whole; // clean autolink / starts odd
    const head = text.slice(0, cut);
    if (!/^https?:\/\//i.test(head)) return whole; // mailto and friends
    let headHref = head;
    try {
      headHref = encodeURI(head);
    } catch {
      return whole; // lone surrogate — leave micromark's output
    }
    return `<a href="${escapeText(headHref)}"${attrs}>${escapeText(head)}</a>${linkifyUrls(text.slice(cut))}`;
  });
}

/**
 * Collapse whitespace-only gaps BETWEEN tags everywhere except inside
 * <pre>…</pre> (code content is significant). micromark pretty-prints tables,
 * lists and blockquotes with newlines between tags; under the panel's pre-wrap
 * body those inter-tag newlines would render as visible blank rows. Code
 * blocks are masked out so their content keeps every newline.
 */
function minifyExceptPre(fragment: string): string {
  const pres: string[] = [];
  const masked = fragment.replace(/<pre[\s\S]*?<\/pre>/g, (m) => {
    pres.push(m);
    return `\u0000${pres.length - 1}\u0000`;
  });
  const collapsed = masked.replace(/>\s+</g, "><");
  return collapsed.replace(/\u0000(\d+)\u0000/g, (_, i) => pres[Number(i)]);
}

interface TopNode {
  kind: "p" | "block";
  html: string;
}

/**
 * Split a micromark fragment into its TOP-LEVEL block nodes. Nested block
 * elements (blockquote > p, blockquote > pre, …) stay inside their parent's
 * html — only depth-0 p/hN/pre/table/ul/ol/blockquote/hr become nodes.
 */
function splitTopLevel(html: string): TopNode[] {
  const nodes: TopNode[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  let depth = 0;
  let cur = "";
  let curKind: "p" | "block" | null = null;
  let m: RegExpExecArray | null;
  let pos = 0;
  const flush = (): void => {
    if (curKind) {
      nodes.push({ kind: curKind, html: cur });
      cur = "";
      curKind = null;
    }
  };
  while ((m = tagRe.exec(html)) !== null) {
    const text = html.slice(pos, m.index);
    if (depth > 0 && curKind) cur += text;
    pos = tagRe.lastIndex;
    const close = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (BLOCK_TAGS.has(tag)) {
      if (tag === "hr") {
        // Void element: standalone top-level node when at depth 0.
        if (depth === 0) {
          flush();
          nodes.push({ kind: "block", html: m[0] });
        } else if (curKind) {
          cur += m[0];
        }
        continue;
      }
      if (!close) {
        if (depth === 0) {
          flush();
          curKind = tag === "p" ? "p" : "block";
        }
        depth++;
      } else {
        depth--;
        if (depth === 0) {
          cur += m[0];
          flush();
        }
      }
      if (depth > 0 && curKind) cur += m[0];
    } else if (depth > 0 && curKind) {
      cur += m[0];
    }
  }
  flush();
  return nodes;
}

/** Unwrap <p>…</p> into bare text (pre-wrap keeps the line structure) and
 *  turn remote markdown images into links (CSP img-src blocks http). */
function pText(pHtml: string): string {
  let inner = pHtml.replace(/^<p>/, "").replace(/<\/p>$/, "");
  inner = inner.replace(/<img\s+src="([^"']+)"[^>]*>/g, (m, url: string) =>
    url.startsWith("data:") ? m : `<a class="md-img-link" href="${url}">[图片]</a>`
  );
  return inner;
}

/** Map a block node onto the panel's class structure (same classes the old
 *  renderer emitted: md-hN / md-table / md-code + the block-copy button). */
function mapBlock(html: string): string {
  let out = html;
  out = out
    .replace(/<h([1-6])>/g, '<div class="md-h$1">')
    .replace(/<\/h([1-6])>/g, "</div>");
  out = out
    .replace(/<pre>/g, '<pre class="md-code">')
    .replace(/<\/pre>/g, '<button class="block-copy" title="复制代码">⧉ 复制</button></pre>');
  if (out.startsWith("<table")) out = '<div class="md-table">' + out + "</div>";
  return out;
}

/**
 * Render markdown message text for the panel.
 * Spacing rule (preserves the web markdown look):
 *  - block nodes: no trailing "\n" (their margins handle spacing);
 *  - text paragraph followed by text: "\n\n" (one visible blank line);
 *  - text paragraph followed by a block: one "\n";
 *  - no trailing newline at the very end.
 */
export function renderMd(text: string): string {
  const src = String(text ?? "");
  if (src.trim() === "") return "";
  const fragment = micromark(src, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: false,
  });
  if (fragment.trim() === "") return "";
  const nodes = splitTopLevel(minifyExceptPre(trimAutolinks(fragment)));
  let out = "";
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === "p") {
      out += pText(n.html);
      if (i < nodes.length - 1) {
        out += nodes[i + 1].kind === "p" ? "\n\n" : "\n";
      }
    } else {
      out += mapBlock(n.html);
    }
  }
  return out.replace(/\n+$/u, "");
}

// Expose to the panel's inline scripts (they call DshMd.render).
(globalThis as unknown as { DshMd?: { render: (text: string) => string } }).DshMd = {
  render: renderMd,
};
