// Cheap extraction of the things agents usually want from verification mail.

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}

/** Most HTML characters converted to text. Longer input is cut, which keeps the cost bounded. */
const MAX_HTML_CHARS = 512 * 1024;
const SKIP_CONTENT = new Set(["script", "style", "head", "title"]);
const BREAK_TAGS = new Set(["br", "/p", "/div", "/tr", "/h1", "/h2", "/h3", "/h4", "/h5", "/h6", "/li", "/table"]);

/**
 * Rough HTML to text for mail with no text/plain part. Not a renderer.
 *
 * A single forward scan with indexOf: every character is visited a bounded number of times, so
 * hostile input (thousands of unterminated `<!--` or `<script`) cannot cause regex backtracking.
 * Hidden content (display:none) is kept; callers must treat the text as untrusted.
 */
export function htmlToText(input: string): string {
  const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  const lower = html.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      if (end === -1) break;
      out.push(" ");
      i = end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      out.push(html.slice(lt + 1));
      break;
    }
    const name = /^\/?[a-z0-9]+/.exec(lower.slice(lt + 1, Math.min(gt, lt + 12)))?.[0] ?? "";
    if (SKIP_CONTENT.has(name)) {
      const close = lower.indexOf("</" + name, gt + 1);
      const closeEnd = close === -1 ? -1 : lower.indexOf(">", close);
      if (closeEnd === -1) break;
      out.push(" ");
      i = closeEnd + 1;
      continue;
    }
    out.push(BREAK_TAGS.has(name) ? "\n" : " ");
    i = gt + 1;
  }
  return decodeEntities(out.join(""))
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CODE_HINT = /\b(code|otp|pin\b|passcode|verif|confirm|one[- ]time|2fa|mfa|token|security|login|log[- ]in|sign[- ]?in|reset|password|activat|authenticat|código|code de|kode|codice)/i;
// \b does not work around CJK text, so these match anywhere.
const CJK_HINT = /(コード|認証|確認|验证码|驗證碼|验证|인증|코드)/;

/**
 * Links and percent-encoded runs (tracking parameters like `utm_medium%253D2004`) are not text a
 * person reads a code from; numbers inside them are ids. They are replaced by a space before
 * scanning. A code that only appears inside a link is still reachable through the link itself.
 */
const NOT_TEXT = /\b(?:https?:\/\/|www\.)\S+|\S*%[0-9A-Fa-f]{2}\S*/g;
const withoutLinks = (s: string) => s.replace(NOT_TEXT, " ");

/**
 * Likely one-time codes, best first. Digit runs of 4-8, plus mixed letter/digit tokens of 5-10
 * when a code-like word is nearby. Years and long numbers are skipped.
 */
export function extractCodes(subject: string, text: string, headerOtp?: string): string[] {
  const scored = new Map<string, number>();
  const add = (code: string, score: number) => {
    scored.set(code, Math.max(scored.get(code) ?? 0, score));
  };
  if (headerOtp) add(headerOtp, 100);

  // A hint before the code counts more than one after it ("code: 1234" vs "1234 is your code").
  const hinted = (s: string) => CODE_HINT.test(s) || CJK_HINT.test(s);
  const hintScore = (src: string, start: number, end: number) =>
    (hinted(src.slice(Math.max(0, start - 80), start)) ? 20 : 0) + (hinted(src.slice(end, end + 40)) ? 8 : 0);
  // Verification mail is short; long mail (newsletters) is full of incidental six-digit numbers.
  const shortBody = text.length <= 3000;

  const scan = (src: string, base: number, isSubject: boolean) => {
    // Sentence punctuation after a code is fine; decimals, times, dates and ids are not.
    const digitRe = /(?<![\w.,/:-])(\d{4,8})(?![\w/:-]|[.,]\d)/g;
    for (const m of src.matchAll(digitRe)) {
      const code = m[1]!;
      if (code.length === 4 && /^(19|20)\d\d$/.test(code)) continue;
      const h = hintScore(src, m.index!, m.index! + code.length);
      // In a body, a number with no code-like word nearby is usually a ZIP, order or phone
      // fragment. Keep it only if it has the most common OTP shape, six digits, in a short mail.
      if (!h && !isSubject && !(code.length === 6 && shortBody)) continue;
      add(code, base + h + (code.length === 6 ? 5 : 0));
    }
    // Spaced or dashed digit codes: "123 456", "123-456".
    for (const m of src.matchAll(/(?<![\w-])(\d{3})[ -](\d{3})(?![\w-]|[.,]\d)/g)) {
      const h = hintScore(src, m.index!, m.index! + 7);
      if (h) add(m[1]! + m[2]!, base + h - 2);
    }
    for (const m of src.matchAll(/(?<![\w-])([A-Z0-9]{5,10})(?![\w-])/g)) {
      const code = m[1]!;
      if (!/\d/.test(code) || !/[A-Z]/.test(code)) continue;
      const h = hintScore(src, m.index!, m.index! + code.length);
      if (h) add(code, base + h - 5);
    }
  };
  scan(withoutLinks(subject), 10, true);
  scan(withoutLinks(text.slice(0, 20_000)), 0, false);

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code]) => code);
}

const LINK_HOST = /^https?:\/\/(?:[^\s/@]+@)?(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i;
const MAX_URL = 4000;
const TRAILING = new Set([")", ".", ",", ";", ":", "!", "?", "'", '"', "]", ">"]);
/** Link candidates examined per message, valid or not. Bounds work on link-stuffed mail. */
const MAX_CANDIDATES = 2000;

/** Memoized "next index of needle from pos": repeated lookups past the same gap cost nothing extra. */
function indexer(s: string) {
  const memo = new Map<string, number>();
  return (needle: string, from: number): number => {
    const known = memo.get(needle);
    if (known !== undefined && (known === -1 || known >= from)) return known;
    const found = s.indexOf(needle, from);
    memo.set(needle, found);
    return found;
  };
}

export interface LinkDetail {
  url: string;
  /** Visible link text (or the alt text of a linked image); "" for links found in plain text. */
  text: string;
}

/** Longest tag (attributes included) the scanner reads; longer ones are skipped. */
const MAX_TAG = 16 * 1024;
/** How far past <a ...> to look for its text, and how much of that text to keep. */
const MAX_ANCHOR_SPAN = 4000;
const MAX_ANCHOR_TEXT = 200;
// eslint-disable-next-line no-control-regex
const BAD_URL_CHAR = /[\u0000-\u0020\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
/** Tags whose href is not something a reader clicks (stylesheets, fonts, base URL). */
const NON_CLICK_TAGS = new Set(["link", "base"]);

/** a-z, 0-9, ":" and "-": the characters of a tag name like "a" or "v:roundrect". */
function isNameChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 58) || c === 45;
}

/** Value of attribute `name` in a tag's attribute string, or null. Quote-aware, linear. */
export function attr(tag: string, lowerTag: string, name: string): string | null {
  let i = 0;
  for (;;) {
    const at = lowerTag.indexOf(name, i);
    if (at === -1) return null;
    i = at + name.length;
    const before = lowerTag[at - 1];
    if (before !== undefined && !/[\s"'/]/.test(before)) continue;
    let j = i;
    while (j < tag.length && /\s/.test(tag[j]!)) j++;
    if (tag[j] !== "=") continue;
    j++;
    while (j < tag.length && /\s/.test(tag[j]!)) j++;
    const q = tag[j];
    if (q === '"' || q === "'") {
      const close = tag.indexOf(q, j + 1);
      return close === -1 ? null : tag.slice(j + 1, close);
    }
    let k = j;
    while (k < tag.length && !/[\s>]/.test(tag[k]!)) k++;
    return tag.slice(j, k);
  }
}

/** Visible text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
function fragmentText(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") {
      if (inTag) out += " ";
      inTag = false;
    } else if (!inTag) out += ch;
  }
  return decodeEntities(out).replace(/\s+/g, " ").trim();
}

/**
 * http(s) links with their visible text: clickable hrefs from the HTML (not <link> stylesheets or
 * fonts), then links in the text body, in order of first appearance, de-duplicated.
 * Hand-written scanning, no backtracking regex over attacker input, linear in the input. Links come
 * from untrusted mail: the visible text can say anything, and can differ from where the href goes.
 */
export function extractLinkDetails(text: string, html: string | undefined, max = 50): LinkDetail[] {
  const byUrl = new Map<string, LinkDetail>();
  /** Label lookups per URL, so many copies of one unlabelled link cannot multiply the work. */
  const labelTries = new Map<string, number>();
  let candidates = 0;
  const push = (raw: string, label: () => string) => {
    candidates++;
    const trimmed = raw.trim();
    if (trimmed.length > MAX_URL * 2) return;
    // Browsers drop tabs and newlines inside URLs (wrapped hrefs) and encode spaces; any other
    // control character means it is not a real link, and would bloat the stored JSON.
    let url = decodeEntities(trimmed).replace(/[\t\n\r]/g, "").replace(/ /g, "%20");
    if (url.length > MAX_URL || BAD_URL_CHAR.test(url)) return;
    let end = url.length;
    while (end > 0 && TRAILING.has(url[end - 1]!)) end--;
    url = url.slice(0, end);
    // Needs a real-looking host, so text like "https://」の後が" is not taken for a link.
    if (!LINK_HOST.test(url)) return;
    const known = byUrl.get(url);
    if (!known && byUrl.size >= max) return;
    if (known?.text) return;
    const tries = labelTries.get(url) ?? 0;
    const text = tries < 3 ? label().replace(CONTROL_CHARS, "").slice(0, MAX_ANCHOR_TEXT) : "";
    labelTries.set(url, tries + 1);
    if (known) known.text = text;
    else byUrl.set(url, { url, text });
  };

  if (html) {
    const lower = html.toLowerCase();
    const next = indexer(lower);
    let i = 0;
    while (byUrl.size < max && candidates < MAX_CANDIDATES) {
      const lt = lower.indexOf("<", i);
      if (lt === -1) break;
      // Tag name.
      let n = lt + 1;
      while (n < lower.length && isNameChar(lower.charCodeAt(n))) n++;
      const name = lower.slice(lt + 1, n);
      if (!name) {
        i = lt + 1;
        continue;
      }
      // End of tag, skipping quoted attribute values. An unterminated tag skips the scanned span,
      // so hostile input cannot make the scan quadratic.
      let k = n;
      let quote = 0;
      const limit = Math.min(lower.length, lt + MAX_TAG);
      while (k < limit) {
        const ch = lower.charCodeAt(k);
        if (quote) {
          if (ch === quote) quote = 0;
        } else if (ch === 34 || ch === 39) quote = ch; // " '
        else if (ch === 62) break; // >
        k++;
      }
      if (lower.charCodeAt(k) !== 62) {
        i = Math.max(k, lt + 1);
        continue;
      }
      i = k + 1;
      if (NON_CLICK_TAGS.has(name)) continue;
      const tag = html.slice(n, k);
      const href = attr(tag, lower.slice(n, k), "href");
      if (href === null) continue;
      const start = i;
      const tagLower = lower.slice(n, k);
      push(href, () => {
        if (name !== "a") return decodeEntities(attr(tag, tagLower, "alt") ?? attr(tag, tagLower, "title") ?? "").trim();
        const close = next("</a", start);
        const inner = html.slice(start, Math.min(close === -1 ? html.length : close, start + MAX_ANCHOR_SPAN));
        const label = fragmentText(inner);
        if (label) return label;
        const innerLower = inner.toLowerCase();
        const img = innerLower.indexOf("<img");
        return img === -1 ? "" : decodeEntities(attr(inner.slice(img), innerLower.slice(img), "alt") ?? "").trim();
      });
    }
  }
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    if (byUrl.size >= max || candidates >= MAX_CANDIDATES * 2) break;
    push(m[0], () => "");
  }
  return [...byUrl.values()];
}

/** URLs only, for callers that do not need the text. */
export function extractLinks(text: string, html: string | undefined, max = 50): string[] {
  return extractLinkDetails(text, html, max).map((l) => l.url);
}
