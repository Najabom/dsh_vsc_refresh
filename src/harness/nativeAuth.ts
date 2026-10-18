/**
 * Native-harness authentication.
 *
 * A `dsh web` started by the user (or by the official launcher) mints a random
 * per-process launch token and gates every request behind a signed browser
 * cookie. A protocol client cannot obtain the launch token — but the signing
 * secret is PERSISTENT and lives in the harness home's credential store
 * (`<DSH_HOME>/.credentials.yaml`, record `client-connection/browser-session`).
 * Minting our own browser-session cookie from that secret lets the extension
 * talk to a native instance without closing it (the browser UI keeps working
 * side by side) and without the auth bypass the overlay applies to instances
 * WE spawn.
 *
 * Scope guards: loopback hosts only, minted on demand with a short lifetime,
 * never logged. Any unreadable/malformed credential record just disables the
 * feature (callers fall back to the plain client, which then sees 401).
 *
 * Wire format (dsh-client-connection, verified against 0.1.7/0.2.0):
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(JSON{version,authority,issuedAt,expiresAt})
 *                 + "." + base64url(HMAC-SHA256(secret, body))
 *   authority = URL host header ("127.0.0.1:3080")
 * The server accepts any expiry within its configured cookieMaxAgeDays, so a
 * 30-minute window (re-minted per connection) works for every sane setting.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "./storage";

const AUTH_RECORD = "client-connection/browser-session";
const SECRET_BYTES = 32;
const COOKIE_PREFIX = "dsh-auth-";
const COOKIE_TTL_MS = 30 * 60 * 1000;

let enabled = true;

/** Setting `dshVsc.nativeWebAuth` — off restores the stock behavior. */
export function setNativeWebAuthEnabled(value: boolean): void {
  enabled = value;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/**
 * Extract the browser-session signing secret from the credentials YAML.
 * Narrow by design: only the AUTH_RECORD block, only `kind: grant` / `version: 1`.
 * Exported for tests.
 */
export function parseBrowserSessionSecret(text: string): Buffer | undefined {
  let inBlock = false;
  let blockIndent = -1;
  let kind = "";
  let version = "";
  let secret = "";
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed === `${AUTH_RECORD}:`) {
        inBlock = true;
        blockIndent = line.length - line.trimStart().length;
      }
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (line.length - line.trimStart().length <= blockIndent) break;
    if (trimmed.startsWith("kind:")) kind = trimmed.slice("kind:".length).trim();
    else if (trimmed.startsWith("version:")) version = trimmed.slice("version:".length).trim();
    else if (trimmed.startsWith("secret:")) secret = trimmed.slice("secret:".length).trim().replace(/^['"]|['"]$/gu, "");
  }
  if (kind !== "grant" || version !== "1" || secret === "") return undefined;
  const bytes = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return bytes.length === SECRET_BYTES ? bytes : undefined;
}

/** The persistent signing secret for the current harness home (fresh read). */
export function browserSessionSecret(): Buffer | undefined {
  try {
    return parseBrowserSessionSecret(readFileSync(join(dshHome(), ".credentials.yaml"), "utf8"));
  } catch {
    return undefined;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname.endsWith(".localhost");
}

/** Mint a browser-session cookie for `baseUrl`, or undefined when unavailable. */
export function mintBrowserCookie(baseUrl: string, now = Date.now()): { name: string; value: string } | undefined {
  if (!enabled) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (!isLoopback(url.hostname)) return undefined;
  const secret = browserSessionSecret();
  if (!secret) return undefined;
  const authority = url.host;
  const name = COOKIE_PREFIX + base64url(createHash("sha256").update(authority).digest());
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + COOKIE_TTL_MS };
  const body = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const value = `v1.${body}.${base64url(createHmac("sha256", secret).update(body).digest())}`;
  return { name, value };
}

/** Request headers authenticating a loopback base, or undefined when inert. */
export function nativeAuthHeaders(baseUrl: string): Record<string, string> | undefined {
  const cookie = mintBrowserCookie(baseUrl);
  return cookie ? { Cookie: `${cookie.name}=${cookie.value}` } : undefined;
}
