// Fails if hostile input makes extraction or rendering slow (regex backtracking and friends).
// Runs in Node because workerd freezes timers during execution. Payloads are hostile inputs
// found in security review. Budget is generous for slow CI machines; real numbers are a few ms.
import { extractCodes, extractLinks, htmlToText } from "../src/extract";
import { authVerdicts, parseAuthResults } from "../src/authresults";
import { rewriteEmailHtml } from "../src/view";

const cids = new Set(Array.from({ length: 50 }, (_, i) => `n${i}`).concat("a"));
const render = (html: string) => rewriteEmailHtml(html, "x", "1.0.a", "/0123456789abcdef0123456789abcdef", { cids, remote: false });

const BUDGET_MS = 150;
const cases: [string, () => unknown][] = [
  ["link trailing punctuation (text)", () => extractLinks("https://a.example/" + ")".repeat(100_000) + "a", undefined)],
  ["link trailing punctuation (href)", () => extractLinks("", `<a href="https://a.example/${")".repeat(100_000)}a">x</a>`)],
  ["unterminated href quotes", () => extractLinks("", '<a href="x '.repeat(40_000))],
  ["unterminated single-quoted hrefs", () => extractLinks("", "<a href='x ".repeat(40_000))],
  ["many hrefs", () => extractLinks("", '<a href="https://a.example/x">y</a>'.repeat(20_000))],
  ["anchors with no close, same url", () => extractLinks("", '<a href="https://a.example/x"><b>'.repeat(20_000))],
  ["anchors with huge inner markup", () => extractLinks("", ('<a href="https://a.example/x">' + "<i>z</i>".repeat(500) + "</a>").repeat(60))],
  ["50 distinct anchors, no close", () => extractLinks("", Array.from({ length: 60 }, (_, i) => `<a href="https://a.example/${i}">`).join("") + "w ".repeat(200_000))],
  ["tags with unbalanced quotes", () => extractLinks("", '<a title="x>'.repeat(40_000))],
  ["href inside attribute values", () => extractLinks("", `<div data-x="${'href="https://a.example/1" '.repeat(1000)}">`.repeat(30))],
  ["many short tags", () => extractLinks("", "<b>".repeat(170_000))],
  ["lone angle brackets", () => extractLinks("", "< ".repeat(250_000))],
  ["unterminated comments", () => htmlToText("<!--".repeat(60_000))],
  ["unterminated script", () => htmlToText("<script".repeat(40_000))],
  ["unterminated tags", () => htmlToText("<".repeat(250_000))],
  ["nested-looking tags", () => htmlToText("<b<b<b".repeat(40_000))],
  ["long whitespace", () => htmlToText("a" + " ".repeat(250_000) + "\n" + " ".repeat(250_000) + "b")],
  ["huge subject codes", () => extractCodes("code ".repeat(4_000), "")],
  ["digits soup", () => extractCodes("", "1234 ".repeat(50_000))],
  ["render: unterminated meta", () => render("<meta ".repeat(60_000))],
  ["render: unterminated meta quote", () => render('<meta x="'.repeat(40_000))],
  ["render: many link hints", () => render('<link rel="preconnect" href="https://a.example">'.repeat(8_000))],
  ["render: unterminated script", () => render("<script".repeat(40_000))],
  ["render: many cid refs", () => render('<img src="cid:a">'.repeat(20_000))],
  ["render: many distinct cids", () => render(Array.from({ length: 20_000 }, (_, i) => `<img src="cid:n${i}">`).join(""))],
  ["auth: deep comments", () => parseAuthResults("mx.cloudflare.net; " + "(".repeat(4_000) + ")".repeat(4_000))],
  ["auth: many parts", () => parseAuthResults("mx.cloudflare.net" + "; dkim=pass header.d=a.example".repeat(250))],
  ["auth: long hostname", () => parseAuthResults("mx.cloudflare.net; dkim=pass header.d=" + "a-".repeat(3_000) + "a.example")],
  ["auth: header scan", () => authVerdicts(new TextEncoder().encode("DKIM-Signature: x\r\n".repeat(3_000) + "\r\nbody"), "a@b.example")],
];

let failed = 0;
for (const [name, fn] of cases) {
  fn(); // warm up
  const t = performance.now();
  fn();
  const ms = performance.now() - t;
  const ok = ms < BUDGET_MS;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "SLOW"} ${ms.toFixed(1).padStart(7)} ms  ${name}`);
}
if (failed) {
  console.error(`${failed} case(s) over ${BUDGET_MS} ms`);
  process.exit(1);
}
