import { describe, expect, it } from "vitest";
import { actionLink, linkKind } from "../src/action";

const L = (url: string, text = "") => ({ url, text });

describe("action link", () => {
  it("picks the link a sign-up mail is about, by its text first", () => {
    expect(actionLink([L("https://a.example/home", "Home"), L("https://a.example/v?t=1", "Verify your email")])).toEqual({
      kind: "Verify",
      url: "https://a.example/v?t=1",
      text: "Verify your email",
    });
    expect(actionLink([L("https://a.example/x", "Reset password")])?.kind).toBe("Reset");
    expect(actionLink([L("https://a.example/x", "Choose a new password")])?.kind).toBe("Reset");
    expect(actionLink([L("https://a.example/x", "Sign in with this link")])?.kind).toBe("Sign in");
    expect(actionLink([L("https://a.example/x", "Accept the invitation")])?.kind).toBe("Invite");
    expect(actionLink([L("https://a.example/x", "Join your team")])?.kind).toBe("Invite");
  });

  it("falls back to the address when no link text says, and kinds are tried in order", () => {
    expect(actionLink([L("https://a.example/account/verify?token=abc")])?.kind).toBe("Verify");
    expect(actionLink([L("https://a.example/password-reset/abc")])?.kind).toBe("Reset");
    expect(actionLink([L("https://auth.a.example/password/change/2_wB72ifPT4B1phN", "Click here")])?.kind).toBe("Reset");
    expect(actionLink([L("https://a.example/forgot-password?t=1")])?.kind).toBe("Reset");
    expect(actionLink([L("https://a.example/auth/magic-link?t=1")])?.kind).toBe("Sign in");
    expect(actionLink([L("https://a.example/invites/abc/")])?.kind).toBe("Invite");
    // Verify comes before Reset, and text before address within a kind.
    expect(actionLink([L("https://a.example/reset", "Reset password"), L("https://a.example/c", "Confirm account")])?.kind).toBe("Verify");
    expect(actionLink([L("https://a.example/verify-x"), L("https://a.example/y", "Verify now")])?.url).toBe("https://a.example/y");
  });

  it("matches addresses only at word starts in the host and path, never inside tokens or the query", () => {
    expect(actionLink([L("https://news.example/v2/emailclick?d=8XYywk9q5JEg5T8IQAekWPzwBbtkVEVerifLygm3Kz")])).toBeNull();
    expect(actionLink([L("https://news.example/c/AbcVerifyXyz")])).toBeNull();
    expect(actionLink([L("https://a.example/next?step=verify")])).toBeNull();
    expect(actionLink([L("https://gov.example/sign-in/verify?token=abc")])?.kind).toBe("Verify");
    expect(actionLink([L("https://cloud.example/account/accept-invite?source=org", "https://cloud.example/account/accept-invite?source=org")])?.kind).toBe("Invite");
    expect(actionLink([L("https://verify.a.example/t/123")])?.kind).toBe("Verify");
    expect(actionLink([L("https://a.example/auth/confirm_email/abc")])?.kind).toBe("Verify");
  });

  it("ignores link text that is itself an address, leaving the address rules to decide", () => {
    expect(actionLink([L("https://t.example/c?d=1", "https://t.example/c?d=abcVerifXYZ")])).toBeNull();
    expect(actionLink([L("https://t.example/c", "www.t.example/confirm-later")])).toBeNull();
    const a = actionLink([L("https://cloud.example/account/accept-invite?s=1", "https://cloud.example/account/accept-invite?s=1")]);
    expect(a).toEqual({ kind: "Invite", url: "https://cloud.example/account/accept-invite?s=1", text: "https://cloud.example/account/accept-invite?s=1" });
  });

  it("skips links that are never the point, links that aren't http(s), and mail without one", () => {
    expect(actionLink([L("https://a.example/unsubscribe?confirm=1", "Confirm unsubscribe")])).toBeNull();
    expect(actionLink([L("https://a.example/prefs", "Manage your account")])).toBeNull();
    expect(actionLink([L("https://twitter.com/verify", "Follow us")])).toBeNull();
    expect(actionLink([L("javascript:alert(1)", "Verify")])).toBeNull();
    expect(actionLink([L("mailto:a@a.example", "Confirm")])).toBeNull();
    expect(actionLink([L("not a url", "Verify")])).toBeNull();
    expect(actionLink([L("https://a.example/news", "Read more")])).toBeNull();
    expect(actionLink([])).toBeNull();
  });
});

describe("link kinds", () => {
  const k = (url: string, text = "") => linkKind(L(url, text), null);
  it("names the links every mail carries", () => {
    expect(k("https://n.example/u?x=1", "Unsubscribe")).toBe("unsubscribe");
    expect(k("https://n.example/email-preferences")).toBe("unsubscribe");
    expect(k("https://n.example/m/1", "Manage your email preferences")).toBe("unsubscribe");
    expect(k("https://n.example/webversion/abc")).toBe("view");
    expect(k("https://n.example/x", "View this email in your browser")).toBe("view");
    expect(k("https://www.facebook.com/acme", "Facebook")).toBe("social");
    expect(k("https://t.example/c/1", "Instagram")).toBe("social");
    expect(k("https://x.com/acme")).toBe("social");
    for (const t of ["fb", "Insta", "tw", "yt", "in"]) expect(k("https://t.example/c/3", t)).toBe("social");
    expect(k("https://a.example/app/settings/notifications")).toBe("unsubscribe");
    expect(k("https://apps.apple.com/app/id1")).toBe("app");
    expect(k("https://t.example/c/2", "Get it on Google Play")).toBe("app");
    expect(k("https://n.example/privacy", "Privacy Policy")).toBe("legal");
    expect(k("https://n.example/legal/terms")).toBe("legal");
    expect(k("https://n.example/help", "Help Center")).toBe("support");
    expect(k("https://n.example/contact-us")).toBe("support");
    expect(k("https://n.example/", "Acme logo")).toBe("image");
  });

  it("leaves content alone, and marks the action link", () => {
    expect(k("https://n.example/jobs/123", "Senior Security Engineer")).toBe("");
    expect(k("https://n.example/blog/post", "Read more")).toBe("");
    // Text decides over the address: a privacy article is content when its text says so.
    expect(k("https://n.example/blog/privacy-tips", "Five tips for your week")).toBe("");
    const links = [L("https://a.example/verify?t=1", "Verify your email"), L("https://a.example/privacy", "Privacy")];
    const action = actionLink(links);
    expect(links.map((l) => linkKind(l, action))).toEqual(["action", "legal"]);
  });
});
