// Synthetic MIME builders. Never put real mail in this repo.
import { vi } from "vitest";
import { headersOf } from "./headers";

const CRLF = "\r\n";

export interface MailOpts {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  extraHeaders?: string[];
}

function headers(o: MailOpts, contentHeaders: string[]): string {
  return [
    `From: ${o.from ?? "Acme Security <no-reply@acme.example>"}`,
    `To: ${o.to ?? "victim-1@hunt.example"}`,
    `Subject: ${o.subject ?? "Your verification code"}`,
    `Date: ${o.date ?? "Tue, 17 Nov 2026 10:00:00 +0000"}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@acme.example>`,
    "MIME-Version: 1.0",
    ...(o.extraHeaders ?? []),
    ...contentHeaders,
  ].join(CRLF);
}

export function plain(body: string, o: MailOpts = {}): string {
  return headers(o, ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"]) + CRLF + CRLF + body;
}

export function htmlOnly(html: string, o: MailOpts = {}): string {
  return headers(o, ["Content-Type: text/html; charset=utf-8"]) + CRLF + CRLF + html;
}

export function alternative(text: string, html: string, o: MailOpts = {}): string {
  const b = "alt-boundary-123";
  return (
    headers(o, [`Content-Type: multipart/alternative; boundary="${b}"`]) +
    CRLF + CRLF +
    `--${b}${CRLF}Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}${qp(text)}${CRLF}` +
    `--${b}${CRLF}Content-Type: text/html; charset=utf-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${b64lines(html)}${CRLF}` +
    `--${b}--${CRLF}`
  );
}

/** multipart/mixed: an HTML body plus small attachments with the given filenames. */
export function mixedWithFiles(html: string, files: { filename: string; content: string }[], o: MailOpts = {}): string {
  const b = "mix-files-1";
  return (
    headers(o, [`Content-Type: multipart/mixed; boundary="${b}"`]) +
    CRLF + CRLF +
    `--${b}${CRLF}Content-Type: text/html; charset=utf-8${CRLF}${CRLF}${html}${CRLF}` +
    files.map((f) => `--${b}${CRLF}Content-Type: text/plain${CRLF}Content-Disposition: attachment; filename="${f.filename}"${CRLF}${CRLF}${f.content}${CRLF}`).join("") +
    `--${b}--${CRLF}`
  );
}

/** multipart/related with an inline cid image, plus an optional big attachment. */
export function related(html: string, o: MailOpts & { attachmentBytes?: number } = {}): string {
  const rel = "rel-boundary-1";
  const mix = "mix-boundary-1";
  // 1x1 transparent PNG.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const relPart =
    `Content-Type: multipart/related; boundary="${rel}"${CRLF}${CRLF}` +
    `--${rel}${CRLF}Content-Type: text/html; charset=utf-8${CRLF}${CRLF}${html}${CRLF}` +
    `--${rel}${CRLF}Content-Type: image/png${CRLF}Content-Transfer-Encoding: base64${CRLF}Content-ID: <logo@acme>${CRLF}Content-Disposition: inline; filename="logo.png"${CRLF}${CRLF}${png}${CRLF}` +
    `--${rel}--${CRLF}`;
  if (!o.attachmentBytes) return headers(o, []) + CRLF + relPart;
  const big = b64lines(randomBinary(o.attachmentBytes));
  return (
    headers(o, [`Content-Type: multipart/mixed; boundary="${mix}"`]) +
    CRLF + CRLF +
    `--${mix}${CRLF}${relPart}` +
    `--${mix}${CRLF}Content-Type: application/pdf${CRLF}Content-Transfer-Encoding: base64${CRLF}Content-Disposition: attachment; filename="report.pdf"${CRLF}${CRLF}${big}${CRLF}` +
    `--${mix}--${CRLF}`
  );
}

export function latin1(body: string, o: MailOpts = {}): Uint8Array {
  const head = headers(o, ["Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: 8bit"]) + CRLF + CRLF;
  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
  const h = new TextEncoder().encode(head);
  const out = new Uint8Array(h.length + bytes.length);
  out.set(h);
  out.set(bytes, h.length);
  return out;
}

function qp(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => (b === 61 || b > 126 ? "=" + b.toString(16).toUpperCase().padStart(2, "0") : String.fromCharCode(b)))
    .join("");
}

function b64lines(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/.{76}/g, "$&\r\n");
}

export function randomBinary(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

export function fakeMessage(raw: string | Uint8Array, envelope: { to?: string; from?: string } = {}) {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  return {
    from: envelope.from ?? "bounce@acme.example",
    to: envelope.to ?? "victim-1@hunt.example",
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.byteLength,
    headers: headersOf(bytes),
    canBeForwarded: true,
    forward: vi.fn(async () => ({ messageId: "x" })),
    reply: vi.fn(),
    setReject: vi.fn(),
  } as unknown as ForwardableEmailMessage & { forward: ReturnType<typeof vi.fn> };
}

