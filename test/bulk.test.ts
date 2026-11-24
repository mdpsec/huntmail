import { describe, expect, it } from "vitest";
import { domainSuffixes, fromDomain, isBulk, parseBlock } from "../src/bulk";

const hdrs = (o: Record<string, string>) => new Headers(o);

describe("newsletter headers", () => {
  it("needs newsletter headers and a subject that isn't account mail", () => {
    expect(isBulk(hdrs({ "list-unsubscribe": "<https://n.example/u>" }), "This week's deals")).toBe(true);
    expect(isBulk(hdrs({ "list-id": "<news.n.example>" }), "Weekly digest")).toBe(true);
    expect(isBulk(hdrs({ precedence: "bulk" }), "Digest")).toBe(true);
    expect(isBulk(hdrs({}), "This week's deals")).toBe(false);
    for (const s of ["Verify your email", "Confirm your account", "Your one-time passcode", "Reset your password", "Sign in to Acme", "Welcome to Acme", "Your code is 123456", "Security alert", "You're invited", "【ログイン】新しいデバイスでログインが試みられました", "您的验证码", "비밀번호 재설정", "Restablecer contraseña", "You have been removed from the organization Org-1"]) {
      expect(isBulk(hdrs({ "list-unsubscribe": "<https://n.example/u>" }), s)).toBe(false);
    }
  });

  it("finds the From domain and its parents", () => {
    expect(fromDomain("WebMD <news@Messages.WebMD.com>")).toBe("messages.webmd.com");
    expect(fromDomain("news@rei.example")).toBe("rei.example");
    expect(fromDomain("no address")).toBe("");
    expect(domainSuffixes("a.messages.webmd.com")).toEqual(["a.messages.webmd.com", "messages.webmd.com", "webmd.com"]);
    expect(domainSuffixes("")).toEqual([]);
  });

  it("validates block requests", () => {
    expect(parseBlock({ kind: "sender", value: "WebMD.com" })).toEqual({ kind: "sender", value: "webmd.com", scope: "newsletters" });
    expect(parseBlock({ kind: "sender", value: "webmd.com", scope: "all" })).toEqual({ kind: "sender", value: "webmd.com", scope: "all" });
    expect(parseBlock({ kind: "recipient", value: "Old@Hunt.example" })).toEqual({ kind: "recipient", value: "old@hunt.example", scope: "all" });
    expect(parseBlock({ kind: "prefix", value: "acme-" })).toEqual({ kind: "prefix", value: "acme-", scope: "all" });
    for (const bad of [
      null,
      { kind: "sender" },
      { kind: "sender", value: "not a domain" },
      { kind: "sender", value: "com" },
      { kind: "sender", value: "a.example", scope: "some" },
      { kind: "recipient", value: "nope" },
      { kind: "recipient", value: "a@b.example", scope: "newsletters" },
      { kind: "prefix", value: "ab" },
      { kind: "prefix", value: "a b-" },
      { kind: "domain", value: "a.example" },
    ]) {
      expect(typeof parseBlock(bad)).toBe("string");
    }
  });
});
