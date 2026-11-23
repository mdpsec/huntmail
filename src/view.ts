// Rendering mail for people and screenshots.
//
// /view/:id is a small trusted page: our own banner (from the stored summary) and an iframe
// holding the mail. The mail itself is served separately at /view/:id/body. The two are never
// mixed, so mail HTML or CSS cannot hide or restyle the banner. The banner's From line is still
// whatever the sender wrote; the Sender and Verified rows show what can actually be trusted.

import PostalMime from "postal-mime";
import type { Email } from "postal-mime";
import type { MessageOut } from "./store";
import { attr } from "./extract";
import { escapeHtml } from "./util";

/** Full parse for viewing, with the same structural limits used on arrival. */
export async function parseFull(raw: Uint8Array): Promise<Email> {
  return PostalMime.parse(raw, {
    attachmentEncoding: "arraybuffer",
    maxRfc822NestingDepth: 2,
    maxNestingDepth: 50,
    maxPartCount: 1000,
  });
}

function bareCid(cid: string): string {
  return cid.trim().replace(/^<|>$/g, "").toLowerCase();
}

export function findCid(email: Email, cid: string) {
  const want = bareCid(cid);
  return email.attachments.find((a) => a.contentId && bareCid(a.contentId) === want);
}

/**
 * CSP for the mail body. `sandbox` without `allow-scripts` plus `default-src 'none'` means no
 * script can run in it, opened framed or directly. `allow-same-origin` only lets our own outer
 * page measure the body's height for full-page screenshots. Remote content is opt-in, https only.
 */
export function bodyCsp(origin: string, remote: boolean): string {
  const remoteSrc = remote ? " https:" : "";
  return [
    "sandbox allow-same-origin",
    "default-src 'none'",
    `img-src data: ${origin}${remoteSrc}`,
    `style-src 'unsafe-inline'${remoteSrc}`,
    `font-src data:${remoteSrc}`,
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
  ].join("; ");
}

export function outerCsp(origin: string, nonce: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    `frame-src ${origin}`,
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
  ].join("; ");
}

/** Longest tag the rewriter reads; a longer or unterminated tag is copied through unchanged. */
const MAX_TAG = 16 * 1024;
/** Distinct inline images served per message view. Each one is a request to the Worker. */
export const MAX_CID_IMAGES = 20;
/** cid: references rewritten per message (each grows to a signed URL); later ones are dropped. */
const MAX_CID_REFS = 500;
/** <link rel> values that make the browser connect somewhere without loading a styled resource. */
const HINT_RELS = /\b(?:preconnect|dns-prefetch|prefetch|preload|prerender|modulepreload)\b/;

/** End of the tag starting at `lt` (index of its ">"), skipping quoted values; -1 if none. */
function tagEnd(lower: string, from: number, lt: number): number {
  let quote = 0;
  const limit = Math.min(lower.length, lt + MAX_TAG);
  for (let k = from; k < limit; k++) {
    const ch = lower.charCodeAt(k);
    if (quote) {
      if (ch === quote) quote = 0;
    } else if (ch === 34 || ch === 39) quote = ch;
    else if (ch === 62) return k;
  }
  return -1;
}

/**
 * Makes mail HTML safe to frame. Single forward scan, quote-aware, linear in the input.
 * - Drops <meta http-equiv> other than content-type (refresh would navigate the frame away).
 * - Drops <link> resource hints (preconnect, dns-prefetch, ...): CSP does not stop them, and they
 *   would show the sender the viewer's IP. With remote content off, drops every <link>.
 * - Rewrites `cid:` references to signed URLs, only for inline parts that exist and only for the
 *   first MAX_CID_IMAGES of them; other references become empty data: URLs.
 * Scripts are left in place: CSP stops them from running.
 */
export function rewriteEmailHtml(html: string, id: string, token: string, root: string, opts: { cids: Set<string>; remote: boolean }): string {
  const lower = html.toLowerCase();
  const kept: string[] = [];
  let copied = 0;
  let i = 0;
  for (;;) {
    const lt = lower.indexOf("<", i);
    if (lt === -1) break;
    const isMeta = lower.startsWith("meta", lt + 1);
    const isLink = lower.startsWith("link", lt + 1);
    const after = lower.charCodeAt(lt + 5);
    // Only <meta ...> and <link ...>, not <metadata> or <linkx>.
    if (!(isMeta || isLink) || !(after === 32 || after === 9 || after === 10 || after === 13 || after === 47 || after === 62)) {
      i = lt + 1;
      continue;
    }
    const gt = tagEnd(lower, lt + 5, lt);
    if (gt === -1) {
      // Unterminated (or over MAX_TAG): skip what was scanned so the work stays linear.
      i = Math.min(lower.length, lt + MAX_TAG);
      continue;
    }
    const tag = html.slice(lt + 5, gt);
    const tagLower = lower.slice(lt + 5, gt);
    let drop = false;
    if (isMeta) {
      const equiv = attr(tag, tagLower, "http-equiv");
      drop = equiv !== null && equiv.trim().toLowerCase() !== "content-type";
    } else {
      drop = !opts.remote || HINT_RELS.test((attr(tag, tagLower, "rel") ?? "").toLowerCase());
    }
    if (drop) {
      kept.push(html.slice(copied, lt));
      copied = gt + 1;
    }
    i = gt + 1;
  }
  kept.push(html.slice(copied));

  const served = new Map<string, string>();
  let refs = 0;
  const cidUrl = (raw: string): string => {
    const cid = bareCid(raw);
    if (!opts.cids.has(cid) || ++refs > MAX_CID_REFS) return "data:,";
    const known = served.get(cid);
    if (known) return known;
    if (served.size >= MAX_CID_IMAGES) return "data:,";
    const url = `${root}/view/${id}/cid/${encodeURIComponent(cid)}?t=${token}`;
    served.set(cid, url);
    return url;
  };
  return kept.join("").replace(/(["'(\s=])cid:([^"')\s>]{1,512})/gi, (_m, pre: string, cid: string) => `${pre}${cidUrl(cid)}`);
}

/** The mail as a standalone document, for /view/:id/body. */
export function renderBodyHtml(email: Email, id: string, token: string, root: string, remote: boolean): string {
  if (!email.html) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#fff"><pre style="white-space:pre-wrap;word-break:break-word;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:16px">${escapeHtml(email.text ?? "")}</pre></body></html>`;
  }
  const cids = new Set(email.attachments.filter((a) => a.contentId).map((a) => bareCid(a.contentId!)));
  const html = rewriteEmailHtml(email.html, id, token, root, { cids, remote });
  return /^\s*<!doctype/i.test(html) ? html : `<!doctype html>${html}`;
}

/** The trusted outer page: banner from the stored summary, mail in a frame sized to its content. */
export function renderViewPage(m: MessageOut, bodyUrl: string, images: boolean, nonce: string): string {
  const row = (k: string, v: string) => `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>`;
  const notice = images
    ? "Remote images, styles and fonts loaded. The sender can see this viewer's IP."
    : "Remote images, styles and fonts blocked.";
  const original = m.header_to && m.header_to.toLowerCase() !== m.to ? ` (header: ${m.header_to})` : "";
  // The From line is whatever the sender wrote. Show who actually sent it and what Cloudflare
  // could verify, so a forged From is visible in the screenshot.
  const verified = m.auth.verified_domains.length
    ? `${m.auth.verified_domains.join(", ")} (DKIM/DMARC)`
    : "none: the From line is not verified";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>${escapeHtml(m.subject || "(no subject)")}</title>
<style>
html,body{margin:0;background:#fff}
.hm{font:13px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica Neue,sans-serif;color:#0b1220;background:#f8f6fe;border-bottom:1px solid #e4def5;padding:12px 16px}
.hm table{border-collapse:collapse}.hm th{font-weight:400;color:#5b6b84;text-align:left;padding:2px 14px 2px 0;vertical-align:top;white-space:nowrap}
.hm td{padding:2px 0;word-break:break-word}.hm .n{margin-top:6px;color:#a15c00}
iframe{display:block;width:100%;height:80vh;border:0}
</style></head><body>
<div class="hm"><table>${row("From", m.header_from || m.from)}${row("Sender", m.from)}${row("Verified", verified)}${row("To", m.to + original)}${row("Subject", m.subject)}${row("Date", m.sent_at || m.received_at)}${row("Received", m.received_at)}</table><div class="n">${notice}</div></div>
<iframe id="m" src="${escapeHtml(bodyUrl)}" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="message"></iframe>
<script nonce="${nonce}">
(function () {
  var f = document.getElementById("m");
  function fit() {
    try {
      var d = f.contentDocument;
      if (!d || !d.documentElement) return;
      var h = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
      if (h > 0) f.style.height = h + "px";
    } catch (e) {}
  }
  f.addEventListener("load", function () {
    fit();
    try { new ResizeObserver(fit).observe(f.contentDocument.documentElement); } catch (e) {}
  });
})();
</script></body></html>`;
}
