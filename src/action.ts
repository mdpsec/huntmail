// The link a sign-up mail is about: verify the address, confirm the account, reset the password,
// sign in with a magic link, accept an invitation. Picked from the links and the text a reader
// sees beside each: the text first, the address only when no text says. Computed when mail is
// read (from link_details), so the rules can change without re-parsing stored mail.
import type { LinkDetail } from "./extract";

export type ActionKind = "Verify" | "Reset" | "Sign in" | "Invite";

export interface ActionLink {
  kind: ActionKind;
  url: string;
  /** The link text as the sender wrote it ("" when the link had none). */
  text: string;
}

/**
 * Tried in order, each on the link text, then on the address. Address rules see only the host and
 * path (not the query, where tracking tokens live), and only at the start of a word: a random
 * token such as "...VEVerifLy..." must not count as a verify link.
 */
const KINDS: { kind: ActionKind; text: RegExp; url: RegExp }[] = [
  {
    kind: "Verify",
    // Each word needs account wording or must be the whole button: newsletters "activate muscles",
    // "confirm" news and show "verified" reviews in their link text.
    text: new RegExp(
      [
        "\\bverify\\b|\\bverification\\b|verifying (your|my)",
        "confirm (your |my |the |this )?(new )?(email|e-mail|address|account|registration|sign ?up|subscription|identity|phone|number|log ?in|sign ?in|it'?s (you|me))",
        "(activat|validat)\\w* (your |my |the )?(new )?(email|e-mail|address|account|profile|log ?in)",
        "^(yes,? )?(click (here )?to )?(confirm|activate|validate)( now| here)?[.!]?$",
        "complete (your )?(registration|sign ?up)|finish (signing up|setting up)",
      ].join("|"),
    ),
    url: /(?:^|[^a-z0-9])(?:verif|confirm|activat|validat)/,
  },
  {
    kind: "Reset",
    text: /reset|(set|choose|create|change) (a |your )?(new )?password|recover (your |my |the )?(account|password|access|username)|(account|password) recovery/,
    url: /(?:^|[^a-z0-9])(?:reset[-_/]?pass|pass(?:word)?[-_/]?(?:reset|change|forgot)|forgot[-_/]?pass|recover)/,
  },
  {
    kind: "Sign in",
    text: /magic link|(sign|log) ?in (with this link|now|securely)|one[- ]click (sign|log) ?in/,
    url: /(?:^|[^a-z0-9])(?:magic|login[-_]?token|signin[-_]?token)/,
  },
  {
    kind: "Invite",
    text: /accept (the |your |this )?invit|join (the |your )?(team|workspace|organi[sz]ation|project)/,
    url: /(?:^|[^a-z0-9])invit(?:e|ation)s?(?:[^a-z0-9]|$)/,
  },
];

/** Links a mail always carries that are never what it is about. */
const NOT_ACTION = new RegExp(
  "unsubscribe|opt[- ]?out|preferences|privacy|terms|policy|view (it |this )?(email |message )?in (a |your )?browser|webversion|" +
    "facebook|twitter|x\\.com/|linkedin|instagram|youtube|tiktok|apps\\.apple|play\\.google|/help|support|contact us|manage (your )?(account|subscription|email)",
);

function httpUrl(u: string): string {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:" ? u : "";
  } catch {
    return "";
  }
}

function hostPath(u: string): string {
  const p = new URL(u);
  return (p.host + p.pathname).toLowerCase();
}

export type LinkKind = "action" | "unsubscribe" | "view" | "social" | "app" | "legal" | "support" | "image" | "";

const SOCIAL_HOST =
  /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linkedin\.com|lnkd\.in|twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|pinterest\.[a-z.]+|threads\.net|snapchat\.com|reddit\.com|t\.me|telegram\.me|whatsapp\.com|wa\.me|bsky\.app|weibo\.com|line\.me|discord\.gg)$/;
const SOCIAL_TEXT = /^(follow us|find us|join us)\b|^(facebook|fb|instagram|insta|ig|linkedin|in|twitter|tw|x|youtube|yt|tiktok|pinterest|threads|snapchat|reddit|telegram|whatsapp|bluesky|discord)( (logo|icon|page))?$/;
const APP = { host: /^(apps|itunes)\.apple\.com$|^play\.google\.com$|^appgallery\.huawei\.com$/, text: /app ?store|google play|play store|download (the|our) app|get (it on|the app)/ };
const UNSUB = {
  text: /unsubscribe|opt[- ]?out|preferences|manage (your )?(subscription|email|notification)s?|(email|notification|subscription|communication) settings|stop (receiving|these)/,
  url: /unsub|opt-?out|email-?pref|manage-?pref|\/preferences|notification-?settings|settings\/notification/,
};
const VIEW = {
  text: /view (it |this )?(email |message |newsletter )?(in|on|as) (a |your )?(web ?)?(browser|page|web)|web ?version|view online|having trouble (viewing|reading)|can'?t see (this|the)/,
  url: /webversion|web-version|view-?in-?browser|viewonline|emailview/,
};
const LEGAL = /privacy|terms|legal|trademark|cookie|copyright|disclaimer|imprint|impressum|accessibility|gdpr|ccpa/;
const SUPPORT = { text: /\bhelp\b|support|contact( us)?\b|\bfaq|customer (service|care)|feedback/, url: /(^|[^a-z0-9])(help|support|contact|faq|feedback)([^a-z0-9]|$)/ };
const IMAGE = /\b(logo|icon|banner|image|img|spacer|pixel)\b/;

/**
 * What a link is for, so a reader can fold away the links every mail carries. `action` is the
 * message's action link; "" is everything else (the content).
 */
export function linkKind(l: LinkDetail, action: ActionLink | null): LinkKind {
  if (action && l.url === action.url) return "action";
  const shown = l.text.trim().toLowerCase();
  const text = shown.includes("://") || shown.startsWith("www.") ? "" : shown;
  let host = "";
  let path = "";
  try {
    const u = new URL(l.url);
    host = u.hostname.toLowerCase();
    path = (host + u.pathname).toLowerCase();
  } catch {
    // not a URL: text decides
  }
  if (UNSUB.text.test(text) || UNSUB.url.test(path)) return "unsubscribe";
  if (VIEW.text.test(text) || VIEW.url.test(path)) return "view";
  if (SOCIAL_HOST.test(host) || SOCIAL_TEXT.test(text)) return "social";
  if (APP.host.test(host) || APP.text.test(text)) return "app";
  if (LEGAL.test(text) || (!text && LEGAL.test(path))) return "legal";
  if (SUPPORT.text.test(text) || (!text && SUPPORT.url.test(path))) return "support";
  if (IMAGE.test(text)) return "image";
  return "";
}

/** The message's action link, or null. */
export function actionLink(links: LinkDetail[]): ActionLink | null {
  for (const k of KINDS) {
    for (const byUrl of [false, true]) {
      for (const l of links) {
        const url = httpUrl(l.url);
        if (!url) continue;
        // Link text that is itself an address says nothing more than the address (and can carry its
        // tracking token): only the address rules decide.
        const shown = l.text.trim().toLowerCase();
        const text = shown.includes("://") || shown.startsWith("www.") ? "" : shown;
        const addr = url.toLowerCase();
        if (NOT_ACTION.test(text) || NOT_ACTION.test(addr)) continue;
        if (byUrl ? k.url.test(hostPath(url)) : text !== "" && k.text.test(text)) return { kind: k.kind, url, text: l.text.trim() };
      }
    }
  }
  return null;
}
