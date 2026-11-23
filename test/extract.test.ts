import { describe, expect, it } from "vitest";
import { extractCodes, extractLinkDetails, extractLinks, htmlToText } from "../src/extract";

describe("extractCodes", () => {
  it("prefers a code next to a code word", () => {
    const codes = extractCodes("Welcome", "Order 1234 shipped. Your verification code is 482913. Expires in 10 minutes.");
    expect(codes[0]).toBe("482913");
    expect(codes).toContain("1234");
  });
  it("drops unhinted body numbers that are not six digits (ZIPs, order numbers)", () => {
    const codes = extractCodes("Verify your address", "Click the link.\n\n101 Townsend St, San Francisco, CA 94107. Order 12345.");
    expect(codes).toEqual([]);
    expect(extractCodes("", "Thanks!\n\n839201\n\nAcme")).toEqual(["839201"]);
    expect(extractCodes("", "Markets " + "lorem ipsum ".repeat(300) + " index 441618 today")).toEqual([]);
  });
  it("understands CJK code labels", () => {
    expect(extractCodes("", "認証コード\n" + "x ".repeat(2000) + "\n020218")).toEqual([]);
    expect(extractCodes("", "x ".repeat(2000) + "認証コード 020218 有効期限")).toEqual(["020218"]);
    expect(extractCodes("", "您的验证码是 553311")).toEqual(["553311"]);
  });
  it("finds codes in the subject first", () => {
    expect(extractCodes("123456 is your Acme code", "Thanks")[0]).toBe("123456");
  });
  it("skips years, prices, phone fragments and long numbers", () => {
    const codes = extractCodes("", "© 2026 Acme. $1,299.00. Call 555-0100. Ref 1234567890123.");
    expect(codes).not.toContain("2026");
    expect(codes).not.toContain("1299");
    expect(codes).not.toContain("1234567890123");
  });
  it("joins spaced codes and finds alphanumeric codes near hints", () => {
    expect(extractCodes("", "Your login code: 123 456")).toContain("123456");
    expect(extractCodes("", "Enter this security code: K7Q2XB")).toContain("K7Q2XB");
    expect(extractCodes("", "Visit ACME2026 for more")).not.toContain("ACME2026");
  });
  it("puts the OTP-Token header first", () => {
    expect(extractCodes("", "code 111111", "999999")[0]).toBe("999999");
  });

  it("ignores numbers inside links and percent-encoded tracking, and 'pin' inside words", () => {
    const footer =
      "Tracking: https://t.example/c?u=%2526utm_source%253D31%2526utm_medium%253D2004 and t.example/x?a%3D2004%26b%3D123456\n" +
      "Pinterest\n\n651 Brannan Street, San Francisco, CA, 94107\nwww.example.com/r/839201";
    expect(extractCodes("Weekly picks", "Ideas for you " + "x ".repeat(1600) + footer)).toEqual([]);
    // The same code shown as text is still found, in short and long mail.
    expect(extractCodes("", "Your code is 482913. Or open https://acme.example/v?code=482913")).toEqual(["482913"]);
    expect(extractCodes("", "Sign-in code: 553311\n" + "x ".repeat(1600) + "https://a.example/?id=771122")).toEqual(["553311"]);
    // PIN as a word still counts as a hint.
    expect(extractCodes("", "x ".repeat(1600) + "Your PIN: 4821 is ready")).toEqual(["4821"]);
  });
});

describe("extractLinks", () => {
  it("collects href and text links once, decodes entities, trims punctuation", () => {
    const html = `<a href="https://acme.example/verify?t=abc&amp;u=1">Verify</a> <a href='https://acme.example/x'>x</a> <a href="mailto:a@b">m</a>`;
    const text = "Or open https://acme.example/verify?t=abc&u=1. Also (https://acme.example/y).";
    expect(extractLinks(text, html)).toEqual(["https://acme.example/verify?t=abc&u=1", "https://acme.example/x", "https://acme.example/y"]);
  });
});

describe("extractLinks hosts", () => {
  it("ignores scheme fragments without a host", () => {
    expect(extractLinks("「https://」の後が shop.example see https://shop.example/app and http://localhost/x", undefined)).toEqual(["https://shop.example/app"]);
    expect(extractLinks("go http://203.0.113.7:8080/cb?x=1 now", undefined)).toEqual(["http://203.0.113.7:8080/cb?x=1"]);
  });
});

describe("htmlToText", () => {
  it("drops style and script, keeps line breaks", () => {
    const t = htmlToText("<style>p{color:red}</style><p>Hello&nbsp;there</p><script>x()</script><p>Code: <b>1234</b></p>");
    expect(t).toBe("Hello there\nCode: 1234");
  });
});

describe("extractLinkDetails", () => {
  it("pairs each link with its visible text and skips stylesheet and font links", () => {
    const html = `<html><head><link href="https://fonts.googleapis.com/css2?family=Jost" rel="stylesheet"><base href="https://acme.example/"></head>
<body><a class="btn" href="https://click.acme.example/v?t=1&amp;x=2"><span>Verify</span>   your&nbsp;email</a>
<a href='https://acme.example/logo'><img src="cid:logo" alt="Acme home"></a>
<a href="https://acme.example/unsub">Unsubscribe</a><a href="https://click.acme.example/v?t=1&amp;x=2">again</a>
<!--[if mso]><v:roundrect href="https://acme.example/mso" alt="Verify (Outlook)"></v:roundrect><![endif]--></body></html>`;
    expect(extractLinkDetails("plain https://acme.example/plain.", html)).toEqual([
      { url: "https://click.acme.example/v?t=1&x=2", text: "Verify your email" },
      { url: "https://acme.example/logo", text: "Acme home" },
      { url: "https://acme.example/unsub", text: "Unsubscribe" },
      { url: "https://acme.example/mso", text: "Verify (Outlook)" },
      { url: "https://acme.example/plain", text: "" },
    ]);
  });

  it("fills in text from a later copy when the first copy of a link has none", () => {
    const html = `<a href="https://acme.example/r"><img src="x"></a> ... <a href="https://acme.example/r">Reset password</a>`;
    expect(extractLinkDetails("", html)).toEqual([{ url: "https://acme.example/r", text: "Reset password" }]);
  });

  it("caps link text length and survives unterminated tags and quotes", () => {
    const long = "x".repeat(1000);
    expect(extractLinkDetails("", `<a href="https://a.example/1">${long}</a>`)[0]!.text).toHaveLength(200);
    expect(extractLinkDetails("", `<a href="https://a.example/1>never closed <a href="https://a.example/2">two</a>`)).toEqual([]);
    expect(extractLinkDetails("", `<p>x</p><a href="https://a.example/3">three`)).toEqual([{ url: "https://a.example/3", text: "three" }]);
  });
});
