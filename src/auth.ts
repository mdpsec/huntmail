import { enc, toHex } from "./util";

const keyCache = new Map<string, Promise<CryptoKey>>();

/** HMAC key derived from API_KEY per purpose, so links and sessions never reveal the key itself. */
function hmacKey(apiKey: string, purpose: string): Promise<CryptoKey> {
  const cacheKey = purpose + "\0" + apiKey;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", enc.encode(apiKey), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("huntmail-v1"), info: enc.encode(purpose) },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
    })();
    keyCache.set(cacheKey, key);
  }
  return key;
}

async function hmac(apiKey: string, purpose: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(apiKey, purpose), enc.encode(data));
  return toHex(new Uint8Array(sig));
}

/** Constant-time string compare via fixed-length digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

export function requestKey(req: Request): string | null {
  const header = req.headers.get("x-api-key");
  if (header) return header;
  const auth = req.headers.get("authorization");
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** Shorter keys are refused outright, so a weak key cannot be brute-forced through the API. */
export const MIN_KEY_LENGTH = 32;

export function keyConfigured(env: Env): boolean {
  if (env.API_KEY && env.API_KEY.length >= MIN_KEY_LENGTH) return true;
  console.error(JSON.stringify({ event: "weak_api_key", length: env.API_KEY?.length ?? 0 }));
  return false;
}

export async function hasApiKey(req: Request, env: Env): Promise<boolean> {
  if (!keyConfigured(env)) return false;
  const key = requestKey(req);
  return key !== null && (await safeEqual(key, env.API_KEY));
}

export function logAuthFailure(req: Request, path: string): void {
  console.log(JSON.stringify({ event: "auth_fail", path, ip: req.headers.get("cf-connecting-ip") ?? "" }));
}

// Signed view links: /view/<id>?exp=<unix s>&images=<0|1>&sig=<hex>, or the compact token
// t=<exp>.<images>.<sig>. The signature covers id, expiry and the images flag, so a link cannot be
// re-scoped to load remote content.

export async function signView(env: Env, id: string, exp: number, images: boolean): Promise<string> {
  return hmac(env.API_KEY, "view", `${id}\n${exp}\n${images ? 1 : 0}`);
}

export async function verifyView(env: Env, id: string, exp: string | null, images: boolean, sig: string | null): Promise<boolean> {
  if (!keyConfigured(env) || !exp || !sig || !/^[1-9]\d{0,11}$/.test(exp)) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  return safeEqual(sig, await signView(env, id, Number(exp), images));
}

// Session cookie for the inbox UI: <exp>.<sig>.

export const SESSION_COOKIE = "__Host-huntmail";
const SESSION_SECONDS = 12 * 3600;

export async function makeSession(env: Env): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const value = `${exp}.${await hmac(env.API_KEY, "session", String(exp))}`;
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSession(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function hasSession(req: Request, env: Env): Promise<boolean> {
  if (!keyConfigured(env)) return false;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE.replace(/[-]/g, "\\-")}=(\\d+)\\.([0-9a-f]{64})`));
  if (!m) return false;
  if (Number(m[1]) * 1000 < Date.now()) return false;
  return safeEqual(m[2]!, await hmac(env.API_KEY, "session", m[1]!));
}
