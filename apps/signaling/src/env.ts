import { readFileSync } from "node:fs";

/** Minimal .env loader: never overrides a variable already set in the real environment. */
function loadDotEnvFile(path = ".env"): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnvFile();

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  nodeEnv: process.env.NODE_ENV ?? "development",
  /** Comma-separated list of allowed WS origins. Empty in development = allow any (logged). */
  allowedOrigins: csv(process.env.ALLOWED_ORIGINS),
  stunUrls: csv(process.env.STUN_URLS).length
    ? csv(process.env.STUN_URLS)
    : ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"],
  turnUrls: csv(process.env.TURN_URLS),
  turnSecret: process.env.TURN_SECRET,
  /** Fixed username/credential pair, for TURN providers (e.g. free community relays) that hand out static credentials instead of a shared secret to mint short-lived ones from. */
  turnStaticUsername: process.env.TURN_STATIC_USERNAME,
  turnStaticCredential: process.env.TURN_STATIC_CREDENTIAL,
  turnCredentialTtlSeconds: Number(process.env.TURN_CREDENTIAL_TTL_SECONDS ?? 3600),
  /**
   * A SECOND, independent TURN provider added alongside the primary one
   * above (never instead of it) — both end up in the same ICE server list,
   * so ICE naturally tries whichever actually works. This is what lets a
   * free/community relay (e.g. Open Relay Project) serve as a resilient
   * fallback while a self-hosted coturn instance is the primary, without
   * either one being a single point of failure for the other. Static
   * credentials only (free relays hand out fixed, publicly-documented
   * creds, not a shared secret) — see apps/signaling/.env.example.
   */
  fallbackTurnUrls: csv(process.env.FALLBACK_TURN_URLS),
  fallbackTurnStaticUsername: process.env.FALLBACK_TURN_STATIC_USERNAME,
  fallbackTurnStaticCredential: process.env.FALLBACK_TURN_STATIC_CREDENTIAL
};
