// UI themes: light, dark or the system's choice, in one of three palettes (Midnight, the default;
// Nord; Graphite). The choice is a cookie the browser sets from the Theme menu; the Worker reads it
// and serves the page already in those colours, so nothing flashes and no extra script runs early.

export const THEME_COOKIE = "hm-theme";
export const MODES = ["system", "light", "dark"] as const;
export const PALETTES = [
  { key: "midnight", name: "Midnight", short: "Navy and lavender" },
  { key: "nord", name: "Nord", short: "Slate and frost blue" },
  { key: "graphite", name: "Graphite", short: "Neutral greys" },
] as const;

const COOKIE_RE = new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=(system|light|dark)\\.(midnight|nord|graphite)(?:;|$)`);

/** Attributes for <html> from the theme cookie: "" for the defaults (system, Midnight) or anything unknown. */
export function themeAttrs(cookie: string | null): string {
  const m = COOKIE_RE.exec(cookie ?? "");
  if (!m) return "";
  return (m[1] === "system" ? "" : ` data-theme="${m[1]}"`) + (m[2] === "midnight" ? "" : ` data-palette="${m[2]}"`);
}

/** Each palette sets every colour in light and dark (light-dark() follows color-scheme). */
export const THEME_CSS = `
:root{color-scheme:light dark}
:root[data-theme="light"]{color-scheme:light}
:root[data-theme="dark"]{color-scheme:dark}
:root,[data-palette="midnight"]{--bg:light-dark(#f6f4fd,#0b1220);--surface:light-dark(#fff,#0e1729);--surface-3:light-dark(#efebfb,#16233b);--border:light-dark(#e4def5,#18233a);--border-2:light-dark(#d2c9ee,#26354f);--text:light-dark(#0b1220,#e6edf7);--text-2:light-dark(#263247,#cdd6e4);--muted:light-dark(#5b6b84,#8494ad);--accent:light-dark(#7c3aed,#c4b5fd);--on-accent:light-dark(#fff,#1e1145);--good:light-dark(#047857,#4ade80);--warn:light-dark(#a15c00,#fbbf24);--bad:light-dark(#c4262e,#f87171);--row-hover:light-dark(#f6f3fd,#111d33)}
[data-palette="nord"]{--bg:light-dark(#eceff4,#2b303b);--surface:light-dark(#fff,#2e3440);--surface-3:light-dark(#e5e9f0,#3b4252);--border:light-dark(#d8dee9,#3b4252);--border-2:light-dark(#c2cad8,#4c566a);--text:light-dark(#2e3440,#eceff4);--text-2:light-dark(#3b4252,#d8dee9);--muted:light-dark(#5d6880,#9ba6ba);--accent:light-dark(#4c6d9c,#93b4d6);--on-accent:light-dark(#fff,#2e3440);--good:light-dark(#3f6b2a,#8fd18a);--warn:light-dark(#8a5a00,#f5c35c);--bad:light-dark(#b03a46,#ee9aa1);--row-hover:light-dark(#f0f3f7,#343b48)}
[data-palette="graphite"]{--bg:light-dark(#f4f4f5,#111214);--surface:light-dark(#fff,#17181b);--surface-3:light-dark(#ececee,#25262b);--border:light-dark(#e2e2e5,#24252a);--border-2:light-dark(#cfcfd4,#35363d);--text:light-dark(#111214,#ececee);--text-2:light-dark(#2c2d31,#c8c9ce);--muted:light-dark(#62646b,#8b8d95);--accent:light-dark(#18181b,#f4f4f5);--on-accent:light-dark(#fff,#111214);--good:light-dark(#15803d,#4ade80);--warn:light-dark(#92580a,#facc15);--bad:light-dark(#c81e1e,#f87171);--row-hover:light-dark(#f4f4f5,#1e1f23)}
:root,[data-palette]{--card:var(--surface);--fg:var(--text);--mut:var(--muted);--line:var(--border);--row:var(--row-hover);--track:var(--surface-3);--acc:var(--accent);--onacc:var(--on-accent);--bar:var(--accent);--chip:color-mix(in srgb,var(--accent) 13%,transparent);--chipfg:var(--accent);--ongood:var(--on-accent);--accent-weak:color-mix(in srgb,var(--accent) 13%,transparent)}
`;

const ICONS: Record<string, string> = {
  system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  dark: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
};
const icon = (name: string, attrs = "", cls = "i") => `<svg class="${cls}"${attrs} viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const LABEL: Record<string, string> = { system: "System", light: "Light", dark: "Dark" };

/** The top bar's Theme menu. Hidden until ui.js runs it, since it needs scripts. */
export function themeMenu(): string {
  const modes = MODES.map((m) => `<label><input type="radio" name="tm-mode" value="${m}">${icon(m)}${LABEL[m]}</label>`).join("");
  const pals = PALETTES.map(
    (p) =>
      `<label><input type="radio" name="tm-palette" value="${p.key}"><span class="tm-sw" data-palette="${p.key}" aria-hidden="true"><i></i><i></i><i></i></span><span class="tm-name">${p.name}<small>${p.short}</small></span>${icon("check", "", "i tm-tick")}</label>`,
  ).join("");
  return `<div class="tmenu" data-theme-menu hidden><button type="button" class="theme-toggle" data-theme-toggle aria-expanded="false" aria-controls="theme-pop">${MODES.map((m) => icon(m, ` data-icon="${m}"${m === "system" ? "" : " hidden"}`)).join("")}<span>Theme</span></button>
<div class="tm-pop" id="theme-pop" hidden><fieldset class="tm-modes"><legend>Mode</legend>${modes}</fieldset><fieldset class="tm-pals"><legend>Colours</legend>${pals}</fieldset></div></div>`;
}

export const MENU_CSS = `
.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;vertical-align:-3px}
.tmenu{position:relative}.tmenu[hidden],.theme-toggle [hidden]{display:none}
.theme-toggle{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 10px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-2);font-size:12.5px;white-space:nowrap}
.theme-toggle:hover{background:var(--surface-3);color:var(--text);border-color:var(--border)}
.tm-pop{position:absolute;right:0;top:calc(100% + 8px);z-index:20;display:grid;gap:6px;width:264px;padding:8px;border:1px solid var(--border-2);border-radius:10px;background:var(--surface);box-shadow:0 12px 32px rgb(0 0 0 / .18)}
.tm-pop[hidden]{display:none}
.tm-pop fieldset{min-width:0;margin:0;padding:0;border:0}
.tm-pop legend{padding:4px 6px 6px;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.tm-pop input{position:absolute;opacity:0;pointer-events:none}
.tm-pop .tm-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.tm-modes legend{grid-column:1/-1}
.tm-modes label{display:flex;flex-direction:column;align-items:center;gap:4px;padding:7px 0;border:1px solid var(--border);border-radius:8px;color:var(--text-2);font-size:12px;cursor:pointer}
.tm-modes label:hover{background:var(--surface-3);color:var(--text)}
.tm-modes label:has(input:checked){border-color:var(--accent);background:var(--accent-weak);color:var(--text)}
.tm-pals label{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px;color:var(--text);font-size:13px;cursor:pointer}
.tm-pals label:hover{background:var(--row-hover)}
.tm-pals label:has(input:checked){background:var(--surface-3)}
.tm-pop label:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:-2px}
.tm-name{min-width:0}.tm-name small{display:block;color:var(--muted);font-size:11.5px}
.tm-sw{flex:none;display:flex;width:34px;height:22px;overflow:hidden;border:1px solid var(--border-2);border-radius:6px}
.tm-sw i{flex:1}.tm-sw i:nth-child(1){background:var(--bg)}.tm-sw i:nth-child(2){background:var(--accent)}.tm-sw i:nth-child(3){background:var(--surface-3)}
.tm-tick{margin-left:auto;color:var(--accent);visibility:hidden}
.tm-pals label:has(input:checked) .tm-tick{visibility:visible}
`;

/** Runs the menu (part of ui.js): sets <html>'s attributes at once and keeps the choice in the cookie. */
export const MENU_JS = `(function () {
  var root = document.documentElement;
  var menu = document.querySelector("[data-theme-menu]");
  if (!menu) return;
  var btn = menu.querySelector("[data-theme-toggle]");
  var pop = menu.querySelector(".tm-pop");
  var dark = window.matchMedia("(prefers-color-scheme: dark)");
  var names = { system: "System", light: "Light", dark: "Dark" };
  function mode() { return root.getAttribute("data-theme") || "system"; }
  function palette() { return root.getAttribute("data-palette") || "midnight"; }
  function save() {
    document.cookie = "${THEME_COOKIE}=" + mode() + "." + palette() + "; Path=/; Max-Age=31536000; Secure; SameSite=Lax";
  }
  function show() {
    var rs = menu.querySelectorAll("input");
    for (var i = 0; i < rs.length; i++) rs[i].checked = rs[i].value === (rs[i].name === "tm-mode" ? mode() : palette());
    var pal = menu.querySelector('input[name="tm-palette"]:checked');
    btn.title = "Theme: " + (mode() === "system" ? "System, " + (dark.matches ? "dark" : "light") : names[mode()]) +
      (pal ? ", " + pal.closest("label").querySelector(".tm-name").firstChild.textContent : "");
    var icons = btn.querySelectorAll("[data-icon]");
    for (var j = 0; j < icons.length; j++) icons[j].toggleAttribute("hidden", icons[j].getAttribute("data-icon") !== mode());
  }
  function open(on) {
    pop.hidden = !on;
    btn.setAttribute("aria-expanded", String(on));
    if (on) (pop.querySelector("input:checked") || pop.querySelector("input")).focus();
  }
  menu.addEventListener("change", function (e) {
    var r = e.target;
    var attr = r.name === "tm-mode" ? "data-theme" : r.name === "tm-palette" ? "data-palette" : null;
    if (!attr) return;
    if (r.value === "system" || r.value === "midnight") root.removeAttribute(attr); else root.setAttribute(attr, r.value);
    save();
    show();
  });
  btn.addEventListener("click", function () { open(pop.hidden); });
  document.addEventListener("click", function (e) { if (!pop.hidden && !menu.contains(e.target)) open(false); });
  menu.addEventListener("keydown", function (e) { if (e.key === "Escape" && !pop.hidden) { open(false); btn.focus(); } });
  menu.addEventListener("focusout", function (e) { if (!pop.hidden && e.relatedTarget && !menu.contains(e.relatedTarget)) open(false); });
  dark.addEventListener("change", show);
  menu.hidden = false;
  show();
})();
`;
