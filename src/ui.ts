import type { DayCount, DomainCount, MessageOut, Overview, SenderCount, TopEntry } from "./store";
import type { ActionLink } from "./action";
import { type Block, fromDomain } from "./bulk";
import { MENU_CSS, MENU_JS, THEME_CSS, themeMenu } from "./theme";
import { escapeHtml as e } from "./util";

/** UI pages run one script: the copy-to-clipboard helper served at <root>/ui.js, nothing inline. */
export function uiCsp(origin: string, root: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src ${origin}${root}/ui.js`,
    "img-src 'self' data:",
    "frame-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#7c3aed"/><rect x="6" y="9" width="20" height="14" rx="2.5" fill="none" stroke="#fff" stroke-width="2.2"/><path d="M7.5 11 16 17.2 24.5 11" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Header logo, inline so the page does not fetch favicon.svg a second time for it. */
const LOGO = FAVICON_SVG.replace("<svg ", '<svg aria-hidden="true" ');

/** Click a code chip to copy it; click anywhere on an inbox row to open that message. */
export const UI_JS = `function copyCode(c) {
  var v = c.getAttribute("data-copy") || "";
  function done() {
    c.classList.add("copied");
    clearTimeout(c._t);
    c._t = setTimeout(function () { c.classList.remove("copied"); }, 1200);
  }
  function fallback() {
    var t = document.createElement("textarea");
    t.value = v;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    try { if (document.execCommand("copy")) done(); } catch (x) {}
    t.remove();
  }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, fallback);
  else fallback();
}
// Stats page: optional auto-refresh, off unless ticked; the choice is remembered per browser.
(function () {
  var box = document.getElementById("autorefresh");
  if (!box) return;
  var KEY = "hm-autorefresh";
  try { box.checked = localStorage.getItem(KEY) === "1"; } catch (x) {}
  box.addEventListener("change", function () {
    try { localStorage.setItem(KEY, box.checked ? "1" : "0"); } catch (x) {}
  });
  setInterval(function () {
    if (box.checked && document.visibilityState === "visible") location.reload();
  }, 30000);
})();
function rowFor(e) {
  var t = e.target;
  if (!t || !t.closest || t.closest("a,button,input")) return null;
  var row = t.closest("tr[data-href]");
  // Selecting text (e.g. an address) is not a click.
  if (row && String(window.getSelection ? window.getSelection() : "")) return null;
  return row;
}
document.addEventListener("click", function (e) {
  var c = e.target && e.target.closest ? e.target.closest("[data-copy]") : null;
  if (c) { e.preventDefault(); copyCode(c); return; }
  var row = rowFor(e);
  if (!row) return;
  var href = row.getAttribute("data-href");
  if (e.ctrlKey || e.metaKey || e.shiftKey) window.open(href, "_blank", "noopener");
  else location.href = href;
});
document.addEventListener("auxclick", function (e) {
  if (e.button !== 1) return;
  var row = rowFor(e);
  if (row) { e.preventDefault(); window.open(row.getAttribute("data-href"), "_blank", "noopener"); }
});
document.addEventListener("submit", function (e) {
  var f = e.target;
  var msg = f && f.getAttribute && f.getAttribute("data-confirm");
  if (msg && !window.confirm(msg)) e.preventDefault();
});
${MENU_JS}`;

/** The mail's action link: its kind copies the link (paste it into the browser you test with); the arrow opens it. */
function actionChip(a: ActionLink): string {
  const tip = `${a.text ? a.text + "\n" : ""}${a.url}\nClick to copy. Opening it is a click on it: it can use it up.`;
  return `<button type="button" class="chip act" data-copy="${e(a.url)}" title="${e(tip)}">${e(a.kind)}</button><a class="act-open" href="${e(a.url)}" target="_blank" rel="noopener noreferrer nofollow" title="Open in a new tab" aria-label="Open the ${e(a.kind)} link">↗</a>`;
}

/** The Code/link cell: the likeliest code, else the action link. */
function codeOrAction(m: MessageOut): string {
  if (m.codes[0]) return codeChip(m.codes[0]) + (m.codes.length > 1 ? `<span class="mut" title="${e(m.codes.slice(1).join(", "))}">+${m.codes.length - 1}</span>` : "");
  return m.action ? actionChip(m.action) : `<span class="mut">–</span>`;
}

function blockForm(root: string, back: string, kind: string, value: string, scope: string, label: string, confirm: string): string {
  return `<form class="blockf" method="post" action="${root}/blocks" data-confirm="${e(confirm)}"><input type="hidden" name="kind" value="${e(kind)}"><input type="hidden" name="value" value="${e(value)}"><input type="hidden" name="scope" value="${e(scope)}"><input type="hidden" name="back" value="${e(back)}"><button title="${e(confirm)}">${e(label)}</button></form>`;
}

function unblockForm(root: string, id: number, back: string): string {
  return `<form class="blockf" method="post" action="${root}/blocks/${id}/delete"><input type="hidden" name="back" value="${e(back)}"><button title="Remove this block: the mail it rejects arrives again">Unblock</button></form>`;
}

/** Block buttons on a message: newsletters from its sender's domain, or everything to its address. */
function blockButtons(root: string, m: MessageOut): string {
  const back = `${root}/inbox/${m.id}`;
  const domain = fromDomain(m.header_from);
  return (
    (domain
      ? blockForm(root, back, "sender", domain, "newsletters", `Block newsletters from ${domain}`,
          `Reject newsletters from ${domain} and its subdomains from now on? Mail with a code-like or account subject still arrives.`) + " "
      : "") +
    blockForm(root, back, "recipient", m.to, "all", "Block this address", `Reject all mail to ${m.to} from now on?`) +
    ` <span class="mut" style="font-size:12px">Blocked mail bounces and is never stored. <a href="${root}/stats#blocks">Blocks</a></span>`
  );
}

/** A one-time code as a button that copies itself. */
function codeChip(code: string): string {
  return `<button type="button" class="chip code" data-copy="${e(code)}" title="Click to copy">${e(code)}</button>`;
}

const STYLE = `
${THEME_CSS}${MENU_CSS}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica Neue,sans-serif}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1440px;margin:0 auto;padding:0 20px}
.top{background:var(--card);border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;height:54px;gap:12px}
.brand{font-weight:650;font-size:16px;color:var(--fg);letter-spacing:-.01em}.brand:hover{text-decoration:none}
.brand{display:flex;align-items:center;gap:9px}.brand svg{display:block;width:22px;height:22px}
.brand svg rect:first-child{fill:var(--acc)}.brand svg rect+rect,.brand svg path{stroke:var(--onacc)}
.top nav{display:flex;gap:16px;margin-left:24px}.top nav a{color:var(--mut);font-weight:500}.top nav a.on{color:var(--fg)}
.top .tb{margin-left:auto;display:flex;align-items:center;gap:8px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tile .l{font-size:12.5px;color:var(--mut)}.tile .v{font-size:26px;font-weight:600;letter-spacing:-.01em;margin-top:2px}.tile .s{font-size:12px;color:var(--mut);margin-top:2px}
.dtrack{height:8px;border-radius:4px;background:var(--track);overflow:hidden;min-width:60px}.dtrack i{display:block;height:100%;border-radius:4px;background:var(--bar)}
.tag{font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:4px;padding:0 5px;margin-left:6px}
.meter{height:6px;border-radius:3px;background:var(--track);margin-top:8px;overflow:hidden}.meter i{display:block;height:100%;border-radius:3px;background:var(--bar)}
.ok{color:var(--good)}.bad{color:var(--bad)}
.chart{padding:14px 18px 6px}.chart h2,.card h2{font-size:14px;margin:0 0 8px}.card h2{padding:14px 18px 0}
.chart svg{display:block;width:100%;height:auto;max-height:300px}.card .chart h2{padding:0}.chart .bar{fill:var(--bar)}.chart .grid{stroke:var(--line)}.chart text{fill:var(--mut);font-size:11px}
.chart g.col:hover .bar{opacity:.75}.chart .hit{fill:transparent}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start;margin-top:16px}.cols>*{margin-top:0!important}.stack>*+*{margin-top:16px}
details.tbl{padding:0 18px 14px}details.tbl summary{cursor:pointer;color:var(--mut);font-size:12.5px;padding:6px 0}
table.num td,table.num th{white-space:nowrap}table.num td.r,table.num th.r{text-align:right;font-variant-numeric:tabular-nums}
.auto{display:inline-flex;align-items:center;gap:6px;margin-left:auto;font-size:13px;color:var(--mut);cursor:help}.auto input{margin:0}
main{padding:24px 0 48px}
h1{font-size:20px;margin:0;letter-spacing:-.01em;word-break:break-word}
.head{display:flex;align-items:baseline;gap:12px;margin:0 0 14px;flex-wrap:wrap}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.04);overflow:hidden}
.card+.card{margin-top:16px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line)}
input,button{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:7px;padding:7px 10px}
input:focus{outline:2px solid var(--acc);outline-offset:-1px;border-color:transparent}
button{cursor:pointer;background:var(--row)}button:hover{border-color:var(--mut)}
.btn-primary{background:var(--acc);border-color:var(--acc);color:var(--onacc);font-weight:600}.btn-primary:hover{border-color:var(--acc);filter:brightness(1.07)}
table{width:100%;border-collapse:collapse;table-layout:fixed}
th{font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);text-align:left;padding:9px 14px;border-bottom:1px solid var(--line)}
td{padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td.btn{padding-top:6px;padding-bottom:6px;vertical-align:middle}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--row)}tr[data-href]{cursor:pointer}
td.t{color:var(--mut);font-variant-numeric:tabular-nums}
td .sub{display:block;font-size:12px;color:var(--mut);overflow:hidden;text-overflow:ellipsis}
td.s a{color:var(--fg);font-weight:500}
.mut{color:var(--mut)}
.chip{display:inline-block;background:var(--chip);color:var(--chipfg);border-radius:6px;padding:1px 8px;margin:0 6px 4px 0;font:600 13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.chip.act{border:0;cursor:copy;font-family:inherit;font-size:12.5px;margin-right:2px;transition:background .15s,color .15s}.chip.act:hover{filter:brightness(.94)}.chip.act.copied{background:var(--good);color:var(--ongood)}.chip.act.copied::after{content:" \\2713"}
.act-open{display:inline-block;padding:0 4px;color:var(--mut);font-size:13px}.act-open:hover{color:var(--acc);text-decoration:none}
td.cl{white-space:nowrap}td.cl .chip{margin-bottom:0}
.chip.code{border:0;cursor:copy;transition:background .15s,color .15s}.chip.code:hover{filter:brightness(.94)}
.chip.code.copied{background:var(--good);color:var(--ongood)}.chip.code.copied::after{content:" \\2713"}
.empty{padding:40px 14px;text-align:center;color:var(--mut)}
.pager{padding:12px 14px;border-top:1px solid var(--line);display:flex;gap:20px;justify-content:flex-end}
dl{display:grid;grid-template-columns:110px 1fr;gap:8px 16px;margin:0;padding:16px 18px}
dt{color:var(--mut)}dd{margin:0;word-break:break-word;min-width:0}
.links{max-height:260px;overflow:auto;font-size:12.5px;line-height:1.5}
.lk{display:flex;gap:10px;padding:3px 6px;margin:0 -6px;border-radius:5px;cursor:copy}.lk:hover{background:var(--row)}
.lk b{flex:0 0 auto;max-width:40%;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lk span{word-break:break-all;color:var(--mut)}
.lk.copied{background:var(--good);color:var(--ongood)}.lk.copied span{color:var(--ongood)}
.nltog{margin-left:auto;font-size:13px}
.blockf{display:inline}.blockf button{font-size:12.5px;padding:4px 9px}
details.more summary{cursor:pointer;color:var(--mut);font-size:12.5px;margin-top:6px}
.lkk{flex:0 0 auto;font-style:normal;font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:4px;padding:0 5px}
.tools{display:flex;gap:16px;flex-wrap:wrap;align-items:center;padding:12px 18px;border-bottom:1px solid var(--line)}
.tools .mut{margin-left:auto;font-size:12px}
iframe{display:block;width:100%;height:78vh;border:0;background:#fff}
.back{display:inline-block;margin-bottom:10px;color:var(--mut)}
.login{min-height:calc(100vh - 160px);display:flex;align-items:center;justify-content:center}
.login .card{width:100%;max-width:380px;padding:28px}
.login form{display:grid;gap:12px}.login h1{margin-bottom:4px}
.err{color:var(--bad)}
@media (max-width:1200px){.cols{grid-template-columns:minmax(0,1fr)}}
@media (max-width:720px){.hide-sm{display:none}dl{grid-template-columns:1fr}dt{margin-top:6px}}
`;

function page(root: string, title: string, body: string, nav = true, current = "inbox"): string {
  const link = (name: string, label: string) => `<a href="${root}/${name}"${current === name ? ' class="on"' : ""}>${label}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${e(title)} · HuntMail</title><link rel="icon" type="image/svg+xml" href="${root}/favicon.svg"><style>${STYLE}</style><script src="${root}/ui.js" defer></script></head><body>
<div class="top"><div class="wrap"><a class="brand" href="${root}/inbox">${LOGO}HuntMail</a>${nav ? `<nav>${link("inbox", "Inbox")}${link("stats", "Stats")}</nav>` : ""}<div class="tb">${themeMenu()}${nav ? `<form method="post" action="${root}/logout"><button>Log out</button></form>` : ""}</div></div></div>
<main><div class="wrap">${body}</div></main></body></html>`;
}

export function loginPage(root: string, error = ""): string {
  return page(
    root,
    "Log in",
    `<div class="login"><div class="card"><form method="post" action="${root}/login">
<h1>Log in</h1><div class="mut">Use the API key from setup.</div>
<input name="username" value="huntmail" autocomplete="username" hidden>
<input id="k" name="key" type="password" placeholder="API key" autocomplete="current-password" autofocus required>
${error ? `<div class="err">${e(error)}</div>` : ""}<button class="btn-primary">Log in</button></form></div></div>`,
    false,
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtTime(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}

/** "19 Nov 01:01" for lists; full UTC time goes in the title attribute. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Display name only, with the address underneath. */
function sender(m: MessageOut): string {
  // "Name <addr>": split at the last "<" (linear; a regex here was quadratic on hostile input).
  const raw = m.header_from || m.from;
  const lt = raw.lastIndexOf("<");
  if (lt <= 0 || !raw.endsWith(">")) return e(raw);
  const name = raw.slice(0, lt).trim();
  const addr = raw.slice(lt + 1, -1);
  if (!name || !addr || addr.includes(">")) return e(raw);
  return `${e(name)}<span class="sub">${e(addr)}</span>`;
}

function recipient(m: MessageOut): string {
  const original = m.header_to && m.header_to.toLowerCase() !== m.to ? m.header_to : "";
  return `${e(m.to)}${original ? `<span class="sub" title="To header">${e(original)}</span>` : ""}`;
}

/**
 * `newsletters`: "hidden" (the default view; `hiddenCount` of them stored), "shown" (?newsletters=show),
 * or "all" (filtered to one address: a mailbox shows everything).
 */
export function inboxPage(
  root: string,
  rows: MessageOut[],
  f: { to: string; q: string; paged: boolean; next: string | null; newsletters?: "hidden" | "shown" | "all"; hiddenCount?: number },
): string {
  const list = rows.length
    ? rows
        .map(
          (m) => `<tr data-href="${root}/inbox/${e(m.id)}"><td class="t" title="${e(fmtTime(m.received_at))} UTC">${e(shortTime(m.received_at))}</td><td class="hide-sm">${recipient(m)}</td><td class="hide-sm">${sender(m)}</td>
<td class="s"><a href="${root}/inbox/${e(m.id)}">${e(m.subject || "(no subject)")}</a>${m.newsletter ? `<span class="tag" title="Unsubscribe headers, no code and no action link">newsletter</span>` : ""}</td><td class="cl">${codeOrAction(m)}</td></tr>`,
        )
        .join("")
    : "";
  const nl = f.newsletters ?? "all";
  const qs = new URLSearchParams({ ...(f.to ? { to: f.to } : {}), ...(f.q ? { q: f.q } : {}), ...(nl === "shown" ? { newsletters: "show" } : {}) });
  const base = new URLSearchParams({ ...(f.to ? { to: f.to } : {}), ...(f.q ? { q: f.q } : {}) });
  const toggle =
    nl === "hidden"
      ? `<span class="mut nltog">${f.hiddenCount ? `${f.hiddenCount.toLocaleString("en-US")} newsletter${f.hiddenCount === 1 ? "" : "s"} hidden` : "Newsletters hidden"} · <a href="${root}/inbox?${new URLSearchParams({ ...Object.fromEntries(base), newsletters: "show" }).toString()}">Show</a></span>`
      : nl === "shown"
        ? `<span class="mut nltog"><a href="${root}/inbox${base.toString() ? "?" + base.toString() : ""}">Hide newsletters</a></span>`
        : "";
  const filtered = Boolean(f.to || f.q);
  return page(
    root,
    "Inbox",
    `<div class="head"><h1>Inbox</h1><span class="mut">${rows.length ? `${f.paged ? "older · " : ""}${rows.length}${f.next ? "+" : ""} message${rows.length === 1 ? "" : "s"}` : ""}${filtered ? " matching" : ""}</span>${toggle}</div>
<div class="card">
<form class="bar" method="get" action="${root}/inbox">
<input name="to" placeholder="Exact recipient" value="${e(f.to)}" style="flex:1 1 240px">
<input name="q" placeholder="Subject or sender contains" value="${e(f.q)}" style="flex:1 1 220px">
${nl === "shown" ? `<input type="hidden" name="newsletters" value="show">` : ""}<button>Filter</button>${filtered ? `<a href="${root}/inbox">Clear</a>` : ""}</form>
${
  rows.length
    ? `<table><colgroup><col style="width:136px"><col class="hide-sm" style="width:24%"><col class="hide-sm" style="width:21%"><col><col style="width:150px"></colgroup>
<thead><tr><th>Received</th><th class="hide-sm">To</th><th class="hide-sm">From</th><th>Subject</th><th title="The likeliest one-time code; without one, the link the mail is about (verify, reset, sign in, invite)">Code/link</th></tr></thead><tbody>${list}</tbody></table>`
    : `<div class="empty">${filtered ? "No mail matches." : "No mail yet. Send something to any address on your domain."}</div>`
}
${f.next || f.paged ? `<div class="pager">${f.paged ? `<a href="${root}/inbox${qs.toString() ? "?" + qs.toString() : ""}">← Newest</a>` : ""}${f.next ? `<a href="${root}/inbox?${qs.toString() ? qs.toString() + "&" : ""}cursor=${e(f.next)}">Older →</a>` : ""}</div>` : ""}
</div>`,
  );
}

function authLine(m: MessageOut): string {
  const a = m.auth;
  const verified = a.verified_domains.length ? ` · verified: ${a.verified_domains.map((d) => `<span class="chip">${e(d)}</span>`).join("")}` : "";
  return `DKIM ${e(a.dkim)} · SPF ${e(a.spf)} · DMARC ${e(a.dmarc)}${a.spam_score !== null ? ` · spam score ${a.spam_score}` : ""}${verified}`;
}

export function messagePage(root: string, m: MessageOut, viewUrl: string, viewUrlImages: string, bodyUrl: string): string {
  const codes = m.codes.length ? m.codes.map(codeChip).join("") : `<span class="mut">none</span>`;
  // Content and the action link first; the links every mail carries (unsubscribe, social, legal,
  // app stores, view online, support, logos) folded away.
  const linkRow = (l: MessageOut["link_details"][number]) =>
    `<div class="lk" data-copy="${e(l.url)}" title="Click to copy the URL">${l.kind && l.kind !== "action" ? `<i class="lkk">${e(l.kind)}</i>` : ""}${l.text ? `<b>${e(l.text)}</b>` : ""}<span>${e(l.url)}</span></div>`;
  const main = m.link_details.filter((l) => l.kind === "" || l.kind === "action");
  const rest = m.link_details.filter((l) => l.kind !== "" && l.kind !== "action");
  const restKinds = [...new Set(rest.map((l) => l.kind))].join(", ");
  const links = m.links.length
    ? `<div class="links">${main.map(linkRow).join("") || `<span class="mut">no content links</span>`}</div>${
        rest.length ? `<details class="more"><summary>${rest.length} more link${rest.length === 1 ? "" : "s"} (${e(restKinds)})</summary><div class="links">${rest.map(linkRow).join("")}</div></details>` : ""
      }`
    : `<span class="mut">none</span>`;
  const atts = m.attachments.length
    ? m.attachments.map((a) => `${e(a.filename ?? "(unnamed)")} <span class="mut">${e(a.mime_type)}, ${a.size} B${a.inline ? ", inline" : ""}</span>`).join("<br>")
    : `<span class="mut">none</span>`;
  const status = m.parse_status !== "ok" ? ` · parse ${e(m.parse_status)}` : "";
  return page(
    root,
    m.subject || "(no subject)",
    `<a class="back" href="${root}/inbox">← Inbox</a>
<div class="head"><h1>${e(m.subject || "(no subject)")}</h1></div>
<div class="card"><dl>
<dt>From</dt><dd>${e(m.header_from || m.from)} <span class="mut">· envelope ${e(m.from)}</span></dd>
<dt>To</dt><dd>${e(m.to)}${m.header_to && m.header_to.toLowerCase() !== m.to ? ` <span class="mut">· header ${e(m.header_to)}</span>` : ""}</dd>
<dt>Received</dt><dd>${e(fmtTime(m.received_at))} UTC</dd>
<dt>Codes</dt><dd>${codes}${m.codes.length ? ` <span class="mut">click to copy</span>` : ""}</dd>
${m.action ? `<dt>Action link</dt><dd>${actionChip(m.action)} <span class="mut">${e(m.action.text || m.action.url)}</span></dd>` : ""}
<dt>Links</dt><dd>${links}${m.links.length ? `<div class="mut" style="font-size:12px;margin-top:4px">Click a link to copy it. Link text is set by the sender and can differ from where the link goes.</div>` : ""}</dd>
<dt>Attachments</dt><dd>${atts}</dd>
<dt>Sender checks</dt><dd>${authLine(m)}</dd>
<dt>Block</dt><dd>${blockButtons(root, m)}</dd>
</dl></div>
<div class="card"><div class="tools"><a href="${e(viewUrl)}" target="_blank" rel="noopener noreferrer">Open full page</a><a href="${e(viewUrlImages)}" target="_blank" rel="noopener noreferrer">Open with remote images</a><a href="${root}/inbox/${e(m.id)}/raw">Download .eml</a><span class="mut">${m.raw_size.toLocaleString("en-US")} bytes${m.raw_truncated ? " · stored truncated" : ""}${status}</span></div>
<iframe src="${e(bodyUrl)}" sandbox="" referrerpolicy="no-referrer" title="message"></iframe></div>`,
  );
}

/** 1,284 / 12.9K / 3.4M. */
function compact(n: number): string {
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function mb(bytes: number): string {
  return bytes < 10 * 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1048576).toLocaleString("en-US")} MB`;
}

function dayLabel(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Round up to 1, 2 or 5 times a power of ten. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Single-series column chart, one column per day. Native SVG tooltips; no script. */
function dayChart(days: DayCount[]): string {
  // Sized for half the page; capped in height when it spans the full width (see .chart svg).
  const W = 640;
  const H = 230;
  const left = 44;
  const right = 8;
  const top = 10;
  const bottom = 26;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const max = Math.max(1, ...days.map((d) => d.received));
  const step = niceStep(max / 4);
  const yMax = Math.ceil(max / step) * step;
  const band = plotW / days.length;
  const barW = Math.min(24, band - 2);
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const grid: string[] = [];
  for (let v = 0; v <= yMax; v += step) {
    grid.push(`<line class="grid" x1="${left}" x2="${W - right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${compact(v)}</text>`);
  }
  const cols = days.map((d, i) => {
    const cx = left + band * i + band / 2;
    const h = (d.received / yMax) * plotH;
    const x0 = cx - barW / 2;
    const yb = top + plotH;
    const r = Math.min(4, h, barW / 2);
    // Rounded data end, square at the baseline.
    const bar = h > 0
      ? `<path class="bar" d="M${x0.toFixed(1)},${yb} V${(yb - h + r).toFixed(1)} Q${x0.toFixed(1)},${(yb - h).toFixed(1)} ${(x0 + r).toFixed(1)},${(yb - h).toFixed(1)} H${(x0 + barW - r).toFixed(1)} Q${(x0 + barW).toFixed(1)},${(yb - h).toFixed(1)} ${(x0 + barW).toFixed(1)},${(yb - h + r).toFixed(1)} V${yb} Z"/>`
      : "";
    const label = i % 5 === (days.length - 1) % 5 ? `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${dayLabel(d.day)}</text>` : "";
    const tip = `${dayLabel(d.day)}: ${d.received.toLocaleString("en-US")} email${d.received === 1 ? "" : "s"}, ${mb(d.rawBytes)}`;
    return `<g class="col"><title>${e(tip)}</title><rect class="hit" x="${(left + band * i).toFixed(1)}" y="${top}" width="${band.toFixed(1)}" height="${plotH}"/>${bar}${label}</g>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Emails received per day, last ${days.length} days">${grid.join("")}${cols.join("")}</svg>`;
}

function topTable(title: string, rows: TopEntry[]): string {
  const body = rows.length
    ? `<table class="num"><tbody>${rows.map((r) => `<tr><td>${e(r.key)}</td><td class="r">${r.count.toLocaleString("en-US")}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty">No mail yet.</div>`;
  return `<div class="card"><h2>${e(title)}</h2>${body}</div>`;
}

/**
 * Mail per recipient domain, last 30 days: a ranked bar list (one hue, magnitude only), with the
 * numbers beside each bar so nothing depends on reading the bar alone. Domains listed in DOMAINS
 * that got no mail are shown too, so the table answers "which domains are set up".
 */
/** Whole percent, but one decimal near 0 and 100 so 99.7% never reads as "100%". */
function pct(v: number): string {
  if (v === 0 || v === 100) return `${v}%`;
  return `${v < 1 || v > 99 ? v.toFixed(1) : v.toFixed(0)}%`;
}

function domainTable(rows: DomainCount[], setUp: string[], windowDays: number): string {
  const seen = new Set(rows.map((r) => r.domain));
  const all = [...rows, ...setUp.filter((d) => !seen.has(d)).map((domain) => ({ domain, received: 0, today: 0 }))];
  const listed = new Set(setUp);
  const total = rows.reduce((n, r) => n + r.received, 0);
  const max = Math.max(1, ...rows.map((r) => r.received));
  const body = all.length
    ? all
        .map((r) => {
          const share = total ? (r.received / total) * 100 : 0;
          const tag = setUp.length && !listed.has(r.domain) ? `<span class="tag" title="Got mail, but is not in the DOMAINS setting">not in DOMAINS</span>` : "";
          const bar = r.received
            ? `<div class="dtrack"><i style="width:${Math.max(1.5, (r.received / max) * 100).toFixed(1)}%"></i></div>`
            : `<span class="mut">no mail yet</span>`;
          return `<tr title="${e(r.domain)}: ${r.received.toLocaleString("en-US")} emails in ${windowDays} days, ${r.today.toLocaleString("en-US")} today"><td>${e(r.domain)}${tag}</td><td class="hide-sm">${bar}</td><td class="r">${r.received.toLocaleString("en-US")}</td><td class="r hide-sm">${pct(share)}</td><td class="r">${r.today.toLocaleString("en-US")}</td></tr>`;
        })
        .join("")
    : "";
  return `<div class="card"><h2>Mail by domain, last ${windowDays} days (UTC)</h2>${
    body
      ? `<table class="num"><colgroup><col><col class="hide-sm" style="width:34%"><col style="width:84px"><col class="hide-sm" style="width:72px"><col style="width:64px"></colgroup><thead><tr><th>Domain</th><th class="hide-sm"></th><th class="r">Emails</th><th class="r hide-sm">Share</th><th class="r">Today</th></tr></thead><tbody>${body}</tbody></table>`
      : `<div class="empty">No mail yet.</div>`
  }</div>`;
}

export interface StatsData {
  overview: Overview;
  days: DayCount[];
  /** Mail per recipient domain over the same window as `days`. */
  domains: DomainCount[];
  /** Domains from the DOMAINS setting (written by setup), possibly empty. */
  setUp: string[];
  maxStoreBytes: number;
  retentionDays: number;
  top: { sample: number; recipients: TopEntry[] };
  blocks: Block[];
  /** The sites that sent the most mail in the last 7 days. */
  senders: SenderCount[];
}

/** Top senders, last 7 days, each with a button to block its newsletters. */
function sendersTable(root: string, senders: SenderCount[]): string {
  const back = `${root}/stats#senders`;
  const action = (s: SenderCount) =>
    s.block_id
      ? unblockForm(root, s.block_id, back)
      : s.newsletters
        ? blockForm(root, back, "sender", s.domain, "newsletters", "Block",
            `Reject newsletters from ${s.domain} and its subdomains from now on? Mail with a code, an action link or an account subject still arrives.`)
        : `<span class="mut" title="No newsletters from this sender in the last 7 days: nothing to block">–</span>`;
  const rows = senders
    .map(
      (s) =>
        `<tr><td>${e(s.domain)}${s.blocked ? `<span class="tag" title="${s.blocked === "all" ? "All mail from this sender is rejected" : "Newsletters from this sender are rejected; other mail arrives"}">${s.blocked === "all" ? "all blocked" : "blocked"}</span>` : ""}</td><td class="r">${s.messages.toLocaleString("en-US")}</td><td class="r">${s.newsletters.toLocaleString("en-US")}</td><td class="r hide-sm">${e(mb(s.bytes))}</td><td class="r${s.block_id || s.newsletters ? " btn" : ""}">${action(s)}</td></tr>`,
    )
    .join("");
  return `<div class="card" id="senders"><h2>Top senders, last 7 days</h2><p class="mut" style="margin:4px 18px 8px;font-size:12.5px">Grouped by site (news.shop.example counts as shop.example). Newsletters are mail with unsubscribe headers and no code or action link; a sender with many is a good one to block. Blocked mail is not stored, so it stops counting here.</p>${
    senders.length
      ? `<table class="num"><colgroup><col><col style="width:70px"><col style="width:112px"><col class="hide-sm" style="width:84px"><col style="width:104px"></colgroup><thead><tr><th>Sender</th><th class="r">Mail</th><th class="r">Newsletters</th><th class="r hide-sm">Size</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty" style="padding:16px">No mail in the last 7 days.</div>`
  }</div>`;
}

function blocksTable(root: string, blocks: Block[], blocked: number, newsletters: number): string {
  const what = (b: Block) =>
    b.kind === "sender" ? (b.scope === "all" ? "all mail from" : "newsletters from") : b.kind === "recipient" ? "all mail to" : "all mail to addresses starting";
  const rows = blocks
    .map(
      (b) =>
        `<tr><td><span class="mut">${what(b)}</span> ${e(b.value)}</td><td class="r">${b.hits.toLocaleString("en-US")}</td><td class="hide-sm">${b.last_hit ? e(shortTime(b.last_hit)) + " UTC" : `<span class="mut">never</span>`}</td><td class="r btn">${unblockForm(root, b.id, `${root}/stats#blocks`)}</td></tr>`,
    )
    .join("");
  return `<div class="card" id="blocks"><h2>Blocks</h2><p class="mut" style="margin:4px 18px 8px;font-size:12.5px">${blocked.toLocaleString("en-US")} message${blocked === 1 ? "" : "s"} rejected so far. ${newsletters.toLocaleString("en-US")} newsletter${newsletters === 1 ? "" : "s"} stored (hidden in the inbox). Block a sender from Top senders above, or a sender or an address from a message's page.</p>${
    blocks.length
      ? `<table class="num"><colgroup><col><col style="width:90px"><col class="hide-sm" style="width:180px"><col style="width:100px"></colgroup><thead><tr><th>Rejected</th><th class="r">Hits</th><th class="hide-sm">Last</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty" style="padding:16px">No blocks.</div>`
  }</div>`;
}

export function statsPage(root: string, s: StatsData): string {
  const o = s.overview;
  const today = s.days.at(-1)!;
  const week = s.days.slice(-7).reduce((n, d) => n + d.received, 0);
  const used = Math.min(100, (o.storedBytes / s.maxStoreBytes) * 100);
  const when = (t: number | null) => (t ? `${shortTime(new Date(t).toISOString())} UTC` : "none");
  const tip =
    "Reloads this page every 30 seconds while the tab is visible. Each reload is one Worker request (about 120 an hour) " +
    "and database reads: a few hundred, plus about two per email of the last 7 days for Top senders. Fine on Workers Paid; on the free plan it counts toward the 100,000 requests a day " +
    "shared by all your Workers, so leave it off when you are not watching.";
  const failures = o.storeFailures
    ? `<div class="v bad">! ${o.storeFailures.toLocaleString("en-US")}</div><div class="s">mail lost, last ${e(when(o.lastStoreFailure))}</div>`
    : `<div class="v ok">✓ None</div><div class="s">no mail lost</div>`;
  const table = `<details class="tbl"><summary>Show as table</summary><table class="num"><thead><tr><th>Day (UTC)</th><th class="r">Emails</th><th class="r">Size</th></tr></thead><tbody>${[...s.days]
    .reverse()
    .map((d) => `<tr><td>${e(d.day)}</td><td class="r">${d.received.toLocaleString("en-US")}</td><td class="r">${e(mb(d.rawBytes))}</td></tr>`)
    .join("")}</tbody></table></details>`;
  return page(
    root,
    "Stats",
    `<div class="head"><h1>Stats</h1><span class="mut">updated ${e(shortTime(new Date().toISOString()))} UTC</span>
<label class="auto" title="${e(tip)}"><input type="checkbox" id="autorefresh"> Auto-refresh every 30 s <span aria-hidden="true">ⓘ</span></label></div>
<div class="kpis">
<div class="tile"><div class="l">Today (UTC)</div><div class="v">${compact(today.received)}</div><div class="s">${compact(week)} in the last 7 days</div></div>
<div class="tile"><div class="l">Emails stored</div><div class="v">${compact(o.messages)}</div><div class="s">oldest ${e(when(o.oldest))}</div></div>
<div class="tile"><div class="l">Storage</div><div class="v">${e(mb(o.storedBytes))}</div><div class="s">of ${e(mb(s.maxStoreBytes))} cap (${used.toFixed(used < 10 ? 1 : 0)}%)</div><div class="meter" role="img" aria-label="${used.toFixed(1)}% of the storage cap used"><i style="width:${used.toFixed(1)}%"></i></div></div>
<div class="tile" title="Mail over 64 KB (mostly newsletters) is not queued: it is parsed when opened, fetched by id or returned by a wait."><div class="l">Waiting to parse</div><div class="v">${compact(o.pending)}</div><div class="s">${o.failed ? `${o.failed} could not be parsed (raw kept)` : "big mail parses when opened"}</div></div>
<div class="tile"><div class="l">${s.setUp.length ? "Domains set up" : "Domains with mail"}</div><div class="v">${s.setUp.length || s.domains.length}</div><div class="s">${
      s.domains.length ? `most mail: ${e(s.domains[0]!.domain)}` : "no mail yet"
    }</div></div>
<div class="tile"><div class="l">Store failures</div>${failures}</div>
</div>
<div class="cols">
<div class="card"><div class="chart"><h2>Emails per day, last ${s.days.length} days (UTC)</h2>${dayChart(s.days)}</div>${table}</div>
${domainTable(s.domains, s.setUp, s.days.length)}
</div>
<div class="cols">
${sendersTable(root, s.senders)}
<div class="stack">${blocksTable(root, s.blocks, o.blocked, o.newsletters)}${topTable(`Top recipients, newest ${s.top.sample} emails`, s.top.recipients)}</div>
</div>
<p class="mut" style="font-size:12px;margin-top:14px">Daily counts are kept for a year, even after old mail is removed by retention (${s.retentionDays} days) or the size cap.</p>`,
    true,
    "stats",
  );
}
