import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  clientMessageSchema,
  JOIN_ATTEMPTS_PER_WINDOW,
  JOIN_WINDOW_MS,
  MAX_SIGNALING_MESSAGE_BYTES,
  ROOM_CREATE_PER_WINDOW,
  ROOM_CREATE_WINDOW_MS,
  type ServerMessage
} from "@fd9/protocol";
import { env } from "./env.js";
import { generatePeerId } from "./ids.js";
import { log } from "./logger.js";
import { RateLimiter } from "./rateLimit.js";
import { RoomStore, type RoomPeer } from "./rooms.js";
import { buildIceServers } from "./turn.js";

const roomStore = new RoomStore();
const joinLimiter = new RateLimiter(JOIN_ATTEMPTS_PER_WINDOW, JOIN_WINDOW_MS);
const createLimiter = new RateLimiter(ROOM_CREATE_PER_WINDOW, ROOM_CREATE_WINDOW_MS);

interface ConnectionState {
  peerId: string;
  /** Unique per WebSocket upgrade — lets a stale close from a superseded connection be told apart from the current one sharing the same (resumed) peerId. See RoomStore.disconnectPeer. */
  connectionId: string;
  ip: string;
  roomId?: string;
  isAlive: boolean;
}

const connections = new Map<WebSocket, ConnectionState>();

if (env.allowedOrigins.length === 0) {
  log.warn("origin.unrestricted", { note: "ALLOWED_ORIGINS is unset — accepting any Origin. Set it in production." });
}

function originAllowed(origin: string | undefined): boolean {
  if (env.allowedOrigins.length === 0) return true;
  return Boolean(origin && env.allowedOrigins.includes(origin));
}

function clientIp(req: { socket: { remoteAddress?: string | null }; headers: Record<string, unknown> }): string {
  return req.socket.remoteAddress ?? "unknown";
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

type ErrorCode = Extract<ServerMessage, { type: "error" }>["code"];

function error(ws: WebSocket, code: ErrorCode, message: string): void {
  send(ws, { type: "error", code, message });
}

function otherPeer(roomId: string, selfId: string): RoomPeer | undefined {
  const room = roomStore.getById(roomId);
  if (!room) return undefined;
  for (const peer of room.peers.values()) {
    if (peer.id !== selfId) return peer;
  }
  return undefined;
}

function handleMessage(ws: WebSocket, state: ConnectionState, raw: string): void {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    error(ws, "bad-message", "Message was not valid JSON.");
    return;
  }

  const result = clientMessageSchema.safeParse(parsedJson);
  if (!result.success) {
    error(ws, "bad-message", "Message failed validation.");
    return;
  }
  const msg = result.data;

  switch (msg.type) {
    case "create-room": {
      if (!createLimiter.hit(state.ip)) {
        error(ws, "rate-limited", "Too many rooms created recently. Try again shortly.");
        return;
      }
      const peer: RoomPeer = { id: state.peerId, connectionId: state.connectionId, send: (m) => send(ws, m) };
      const room = roomStore.createRoom(peer);
      state.roomId = room.id;
      send(ws, { type: "room-created", roomId: room.id, code: room.code, peerId: state.peerId, expiresAt: room.expiresAt });
      return;
    }

    case "join-room": {
      if (!joinLimiter.hit(state.ip)) {
        error(ws, "rate-limited", "Too many join attempts. Wait a moment and try again.");
        return;
      }
      const room = msg.roomId ? roomStore.getById(msg.roomId) : msg.code ? roomStore.getByCode(msg.code) : undefined;
      if (!room) {
        error(ws, "room-not-found", "That code or link doesn't match an active session.");
        return;
      }
      if (room.peers.size >= 2) {
        error(ws, "room-full", "This session already has two devices connected.");
        return;
      }
      const peer: RoomPeer = { id: state.peerId, connectionId: state.connectionId, send: (m) => send(ws, m) };
      roomStore.join(room, peer);
      state.roomId = room.id;
      send(ws, { type: "joined", roomId: room.id, peerId: state.peerId, isInitiator: false });
      const initiator = room.peers.get(room.initiatorId);
      initiator?.send({ type: "peer-joined", peerId: state.peerId });
      return;
    }

    case "leave-room": {
      if (!state.roomId) return;
      const peer = otherPeer(state.roomId, state.peerId);
      roomStore.leave(state.roomId, state.peerId);
      peer?.send({ type: "peer-left", peerId: state.peerId });
      state.roomId = undefined;
      return;
    }

    case "relay-sdp": {
      if (!state.roomId) {
        error(ws, "room-not-found", "Join a session before signaling.");
        return;
      }
      otherPeer(state.roomId, state.peerId)?.send({ type: "relay-sdp", payload: msg.payload });
      return;
    }

    case "relay-ice": {
      if (!state.roomId) return;
      otherPeer(state.roomId, state.peerId)?.send({ type: "relay-ice", payload: msg.payload });
      return;
    }

    case "request-turn-credentials": {
      const { servers, ttlSeconds } = buildIceServers(state.peerId);
      send(ws, { type: "turn-credentials", servers, ttlSeconds });
      return;
    }

    case "ping": {
      send(ws, { type: "pong" });
      return;
    }

    case "rejoin-room": {
      if (!joinLimiter.hit(state.ip)) {
        error(ws, "rate-limited", "Too many rejoin attempts. Wait a moment and try again.");
        return;
      }
      const peer: RoomPeer = { id: msg.peerId, connectionId: state.connectionId, send: (m) => send(ws, m) };
      const result = roomStore.rejoin(msg.roomId, msg.peerId, peer);
      if (!result.ok) {
        error(ws, "rejoin-failed", "That session can no longer be resumed — it may have expired.");
        return;
      }
      state.peerId = msg.peerId;
      state.roomId = msg.roomId;
      const room = roomStore.getById(msg.roomId);
      send(ws, { type: "rejoined", roomId: msg.roomId, peerId: msg.peerId, isInitiator: room?.initiatorId === msg.peerId });
      result.otherPeer?.send({ type: "peer-reconnected", peerId: msg.peerId });
      return;
    }
  }
}

/**
 * REST alternative to the "request-turn-credentials" WS message, serving
 * the exact same server-minted config (never hard-coded in the frontend).
 * Useful for anything that wants ICE servers without first opening a full
 * signaling session — connectivity diagnostics, health checks, standalone
 * smoke tests. A fresh anonymous peerId is fine here: this endpoint isn't
 * tied to any room/pairing, so there's no real session identity to reuse.
 */
function handleTurnCredentialsRequest(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  const origin = req.headers.origin;
  const allowOrigin = env.allowedOrigins.length === 0 ? "*" : originAllowed(origin) ? (origin as string) : "";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": allowOrigin,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-max-age": "86400"
    });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  if (!allowOrigin) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Origin Forbidden");
    return;
  }

  const { servers, ttlSeconds } = buildIceServers(generatePeerId());
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": allowOrigin
  });
  res.end(JSON.stringify({ servers, ttlSeconds }));
}

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.url === "/api/turn/credentials") {
    handleTurnCredentialsRequest(req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!originAllowed(req.headers.origin)) {
    log.warn("origin.rejected", { origin: req.headers.origin ?? "none" });
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const state: ConnectionState = {
      peerId: generatePeerId(),
      connectionId: generatePeerId(),
      ip: clientIp(req as never),
      isAlive: true
    };
    connections.set(ws, state);
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const state = connections.get(ws);
  if (!state) {
    ws.close(1011, "internal error");
    return;
  }

  ws.on("pong", () => {
    state.isAlive = true;
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      error(ws, "bad-message", "Signaling channel is text-only.");
      return;
    }
    const raw = data.toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_SIGNALING_MESSAGE_BYTES) {
      error(ws, "bad-message", "Message too large.");
      return;
    }
    handleMessage(ws, state, raw);
  });

  ws.on("close", () => {
    if (state.roomId) {
      const { otherPeer: peer, graceMs } = roomStore.disconnectPeer(state.roomId, state.peerId, state.connectionId);
      if (graceMs) {
        peer?.send({ type: "peer-disconnected", peerId: state.peerId, graceMs });
      } else {
        peer?.send({ type: "peer-left", peerId: state.peerId });
      }
    }
    connections.delete(ws);
  });

  ws.on("error", (err) => {
    log.warn("socket.error", { peerId: state.peerId, message: (err as Error).message });
  });
});

// 5s ping cadence (not 30s): a dead connection — e.g. a phone's Wi-Fi<->cellular
// handoff that never sent a clean close — needs to be noticed in single-digit
// seconds, not up to a minute, for the reconnect/ICE-restart path to matter.
const HEARTBEAT_INTERVAL_MS = 5000;
const heartbeat = setInterval(() => {
  for (const [ws, state] of connections) {
    if (!state.isAlive) {
      ws.terminate();
      continue;
    }
    state.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref();

setInterval(() => {
  joinLimiter.sweep();
  createLimiter.sweep();
}, 60_000).unref();

server.listen(env.port, () => {
  log.info("server.listening", { port: env.port, nodeEnv: env.nodeEnv });
});
