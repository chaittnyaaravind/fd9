import { createHmac } from "node:crypto";
import type { TurnServer } from "@fd9/protocol";
import { env } from "./env.js";

/**
 * Mints credentials for whatever TURN service TURN_URLS points at — this is
 * deliberately provider-agnostic, not tied to any one vendor:
 *   - TURN_SECRET: coturn-style shared secret (use-auth-secret), works with
 *     any self-hosted or hosted coturn instance that shares the same secret.
 *   - TURN_STATIC_USERNAME/TURN_STATIC_CREDENTIAL: a fixed credential pair,
 *     for a TURN service that hands those out directly instead of a secret.
 * Swapping TURN providers later only ever means changing env vars here —
 * no code in this file or the client needs to know which provider it is.
 * If TURN_URLS/credentials aren't configured, only STUN is returned and the
 * client surfaces that honestly instead of pretending relay is available.
 */
/**
 * Builds the FULL ice server list: STUN, the primary TURN provider (if
 * configured), and a fallback TURN provider (if configured) — all three
 * categories are independent and additive, never mutually exclusive. ICE
 * itself already prefers host/srflx pairs over any relay pair by priority,
 * and tries every relay entry it's given, so simply including both TURN
 * providers here (rather than picking one) is what makes neither of them a
 * single point of failure: if the primary (e.g. self-hosted coturn) has an
 * outage, ICE still has the fallback's candidates to fall back to, with no
 * client-side retry logic required.
 */
export function buildIceServers(peerId: string): { servers: TurnServer[]; ttlSeconds: number } {
  const servers: TurnServer[] = env.stunUrls.map((url) => ({ urls: [url] }));
  let ttlSeconds = 0;

  if (env.turnUrls.length > 0) {
    if (env.turnSecret) {
      const ttl = env.turnCredentialTtlSeconds;
      const username = `${Math.floor(Date.now() / 1000) + ttl}:${peerId}`;
      const credential = createHmac("sha1", env.turnSecret).update(username).digest("base64");
      servers.push({ urls: env.turnUrls, username, credential });
      ttlSeconds = Math.max(ttlSeconds, ttl);
    } else if (env.turnStaticUsername && env.turnStaticCredential) {
      servers.push({ urls: env.turnUrls, username: env.turnStaticUsername, credential: env.turnStaticCredential });
      ttlSeconds = Math.max(ttlSeconds, env.turnCredentialTtlSeconds);
    }
  }

  if (env.fallbackTurnUrls.length > 0 && env.fallbackTurnStaticUsername && env.fallbackTurnStaticCredential) {
    servers.push({
      urls: env.fallbackTurnUrls,
      username: env.fallbackTurnStaticUsername,
      credential: env.fallbackTurnStaticCredential
    });
    ttlSeconds = Math.max(ttlSeconds, env.turnCredentialTtlSeconds);
  }

  return { servers, ttlSeconds };
}
