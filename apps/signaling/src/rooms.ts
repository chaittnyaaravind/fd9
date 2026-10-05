import type { ServerMessage } from "@fd9/protocol";
import { RECONNECT_GRACE_MS, ROOM_TTL_MS, SESSION_TTL_MS } from "@fd9/protocol";
import { generateRoomCode, generateRoomId } from "./ids.js";
import { log } from "./logger.js";

export interface RoomPeer {
  id: string;
  send: (message: ServerMessage) => void;
  /** Identifies the specific WebSocket connection currently serving this peer — see disconnectPeer. */
  connectionId: string;
}

export interface Room {
  id: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  initiatorId: string;
  peers: Map<string, RoomPeer>;
  /** Every peerId that has ever been part of this room — kept after a disconnect so a rejoin can be validated. */
  knownPeerIds: Set<string>;
  /** Armed while a peer is disconnected-but-within-grace; cleared on rejoin or on expiry (which destroys the room). */
  pendingDisconnect?: { peerId: string; timer: NodeJS.Timeout };
}

export type RoomCloseReason = "waiting-timeout" | "session-timeout" | "peer-left" | "empty" | "disconnect-timeout";

export class RoomStore {
  private readonly byId = new Map<string, Room>();
  private readonly idByCode = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  createRoom(initiator: RoomPeer): Room {
    const id = generateRoomId();
    const code = generateRoomCode();
    const now = Date.now();
    const room: Room = {
      id,
      code,
      createdAt: now,
      expiresAt: now + ROOM_TTL_MS,
      initiatorId: initiator.id,
      peers: new Map([[initiator.id, initiator]]),
      knownPeerIds: new Set([initiator.id])
    };
    this.byId.set(id, room);
    this.idByCode.set(code, id);
    this.armTimer(id, ROOM_TTL_MS, "waiting-timeout");
    log.info("room.created", { roomId: id });
    return room;
  }

  getById(id: string): Room | undefined {
    return this.byId.get(id);
  }

  getByCode(code: string): Room | undefined {
    const id = this.idByCode.get(code);
    return id ? this.byId.get(id) : undefined;
  }

  /** Throws "full" if the room already has two peers. */
  join(room: Room, peer: RoomPeer): void {
    if (room.peers.size >= 2) throw new Error("full");
    room.peers.set(peer.id, peer);
    room.knownPeerIds.add(peer.id);
    room.expiresAt = Date.now() + SESSION_TTL_MS;
    this.armTimer(room.id, SESSION_TTL_MS, "session-timeout");
    log.info("room.joined", { roomId: room.id, peers: room.peers.size });
  }

  /** Explicit leave (user action) or final teardown of a not-yet-paired room: always destroys immediately. */
  leave(roomId: string, peerId: string): Room | undefined {
    const room = this.byId.get(roomId);
    if (!room) return undefined;
    room.peers.delete(peerId);
    this.destroy(roomId, "peer-left");
    return room;
  }

  /**
   * A peer's WebSocket dropped (not an explicit leave-room). If the room was
   * paired, give it a grace window to rejoin — a phone flipping Wi-Fi<->cellular
   * tears down its WebSocket's TCP connection even though the user never left.
   * If the room was never paired, there's nobody left to wait for: destroy now.
   *
   * `connectionId` guards against a stale close: if this peerId already
   * rejoined on a NEWER WebSocket by the time this (older) connection's
   * close event is finally noticed — e.g. the old socket was offline when it
   * tried to close, so the server only sees it die well after a successful
   * rejoin — this must NOT tear down the connection that's actually live.
   *
   * Returns the other peer (if any) so the caller can tell them
   * "disconnected, might come back" instead of a final "peer-left".
   */
  disconnectPeer(roomId: string, peerId: string, connectionId: string): { otherPeer?: RoomPeer; graceMs?: number } {
    const room = this.byId.get(roomId);
    if (!room) return {};
    const current = room.peers.get(peerId);
    if (current && current.connectionId !== connectionId) {
      // Superseded already — this close event is stale, not a real disconnect.
      return {};
    }
    room.peers.delete(peerId);

    const other = [...room.peers.values()][0];
    if (!other || room.knownPeerIds.size < 2) {
      this.destroy(roomId, "peer-left");
      return { otherPeer: other };
    }

    const existing = this.timers.get(roomId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      const current = this.byId.get(roomId);
      if (!current) return;
      const remaining = [...current.peers.values()][0];
      remaining?.send({ type: "peer-left", peerId });
      this.destroy(roomId, "disconnect-timeout");
    }, RECONNECT_GRACE_MS);
    timer.unref?.();
    this.timers.set(roomId, timer);
    room.pendingDisconnect = { peerId, timer };

    log.info("room.peer-disconnected", { roomId, peerId, graceMs: RECONNECT_GRACE_MS });
    return { otherPeer: other, graceMs: RECONNECT_GRACE_MS };
  }

  /**
   * Resume a session on a new WebSocket as a previously-known peerId. Returns
   * `ok: false` if the room is gone, expired, or this peerId was never part
   * of it (the roomId itself is already a 144-bit capability token — see
   * ROOM_ID_BYTES — so this isn't guessable, but validate anyway).
   */
  rejoin(roomId: string, peerId: string, peer: RoomPeer): { ok: boolean; otherPeer?: RoomPeer } {
    const room = this.byId.get(roomId);
    if (!room || !room.knownPeerIds.has(peerId) || room.peers.has(peerId)) {
      return { ok: false };
    }

    if (room.pendingDisconnect?.peerId === peerId) {
      clearTimeout(room.pendingDisconnect.timer);
      room.pendingDisconnect = undefined;
    }

    room.peers.set(peerId, peer);
    room.expiresAt = Date.now() + SESSION_TTL_MS;
    this.armTimer(room.id, SESSION_TTL_MS, "session-timeout");

    const other = [...room.peers.values()].find((p) => p.id !== peerId);
    log.info("room.peer-reconnected", { roomId, peerId });
    return { ok: true, otherPeer: other };
  }

  destroy(roomId: string, _reason: RoomCloseReason): void {
    const room = this.byId.get(roomId);
    if (!room) return;
    this.byId.delete(roomId);
    this.idByCode.delete(room.code);
    const timer = this.timers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(roomId);
    }
    log.info("room.destroyed", { roomId, reason: _reason });
  }

  private armTimer(roomId: string, delayMs: number, reason: RoomCloseReason): void {
    const existing = this.timers.get(roomId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      const room = this.byId.get(roomId);
      if (!room) return;
      for (const peer of room.peers.values()) {
        peer.send({ type: "error", code: "room-expired", message: "This session expired." });
      }
      this.destroy(roomId, reason);
    }, delayMs);
    timer.unref?.();
    this.timers.set(roomId, timer);
  }

  /** Test/ops hook: number of live rooms. */
  get size(): number {
    return this.byId.size;
  }
}
