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
    text: /verif|confirm|activat|validat|complete (your )?(registration|sign ?up)|finish (signing up|setting up)/,
    url: /(?:^|[^a-z0-9])(?:verif|confirm|activat|validat)/,
  },
  {
    kind: "Reset",
    text: /reset|(set|choose|create|change) (a |your )?(new )?password|recover/,
    url: /(?:^|[^a-z0-9])(?:reset[-_/]?pass|pass(?:word)?[-_/]?reset|recover)/,
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
