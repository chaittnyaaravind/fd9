import { afterEach, describe, expect, it } from "vitest";
import { env } from "../src/env.js";
import { buildIceServers } from "../src/turn.js";

const original = {
  turnUrls: env.turnUrls,
  turnSecret: env.turnSecret,
  turnStaticUsername: env.turnStaticUsername,
  turnStaticCredential: env.turnStaticCredential,
  fallbackTurnUrls: env.fallbackTurnUrls,
  fallbackTurnStaticUsername: env.fallbackTurnStaticUsername,
  fallbackTurnStaticCredential: env.fallbackTurnStaticCredential
};

function reset() {
  env.turnUrls = original.turnUrls;
  env.turnSecret = original.turnSecret;
  env.turnStaticUsername = original.turnStaticUsername;
  env.turnStaticCredential = original.turnStaticCredential;
  env.fallbackTurnUrls = original.fallbackTurnUrls;
  env.fallbackTurnStaticUsername = original.fallbackTurnStaticUsername;
  env.fallbackTurnStaticCredential = original.fallbackTurnStaticCredential;
}

describe("buildIceServers", () => {
  afterEach(reset);

  it("returns only STUN servers when no TURN provider is configured", () => {
    env.turnUrls = [];
    env.fallbackTurnUrls = [];
    const { servers, ttlSeconds } = buildIceServers("peer1");
    expect(servers.every((s) => !JSON.stringify(s.urls).includes("turn:"))).toBe(true);
    expect(ttlSeconds).toBe(0);
  });

  it("mints an HMAC-secret credential for the primary provider when TURN_SECRET is set", () => {
    env.turnUrls = ["turn:primary.example.com:3478"];
    env.turnSecret = "shh";
    env.turnStaticUsername = undefined;
    env.turnStaticCredential = undefined;
    env.fallbackTurnUrls = [];
    const { servers, ttlSeconds } = buildIceServers("peer1");
    const primary = servers.find((s) => JSON.stringify(s.urls).includes("primary.example.com"));
    expect(primary).toBeDefined();
    expect(primary!.username).toContain("peer1");
    expect(primary!.credential).toBeTruthy();
    expect(ttlSeconds).toBeGreaterThan(0);
  });

  it("adds the fallback provider ALONGSIDE the primary — neither replaces the other", () => {
    env.turnUrls = ["turn:primary.example.com:3478"];
    env.turnSecret = "shh";
    env.fallbackTurnUrls = ["turn:fallback.example.com:80", "turn:fallback.example.com:443?transport=tcp"];
    env.fallbackTurnStaticUsername = "openrelayproject";
    env.fallbackTurnStaticCredential = "openrelayproject";

    const { servers } = buildIceServers("peer1");
    const primary = servers.find((s) => JSON.stringify(s.urls).includes("primary.example.com"));
    const fallback = servers.find((s) => JSON.stringify(s.urls).includes("fallback.example.com"));
    expect(primary, "primary provider missing").toBeDefined();
    expect(fallback, "fallback provider missing").toBeDefined();
    expect(fallback!.username).toBe("openrelayproject");
  });

  it("serves the fallback alone when only it is configured (primary TURN down/unconfigured)", () => {
    env.turnUrls = [];
    env.turnSecret = undefined;
    env.fallbackTurnUrls = ["turn:fallback.example.com:80"];
    env.fallbackTurnStaticUsername = "openrelayproject";
    env.fallbackTurnStaticCredential = "openrelayproject";

    const { servers, ttlSeconds } = buildIceServers("peer1");
    const fallback = servers.find((s) => JSON.stringify(s.urls).includes("fallback.example.com"));
    expect(fallback).toBeDefined();
    expect(ttlSeconds).toBeGreaterThan(0);
  });
});
