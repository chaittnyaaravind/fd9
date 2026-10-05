import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@fd9/protocol";
import { RoomStore, type RoomPeer } from "../src/rooms.js";

function fakePeer(id: string, connectionId = "conn-1") {
  const messages: ServerMessage[] = [];
  const peer: RoomPeer = { id, connectionId, send: (m) => messages.push(m) };
  return { peer, messages };
}

describe("RoomStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a room with a resolvable id and code", () => {
    const store = new RoomStore();
    const { peer } = fakePeer("alice");
    const room = store.createRoom(peer);
    expect(store.getById(room.id)).toBe(room);
    expect(store.getByCode(room.code)).toBe(room);
  });

  it("allows a second peer to join and notifies the initiator", () => {
    const store = new RoomStore();
    const { peer: alice } = fakePeer("alice");
    const { peer: bob, messages: bobMsgs } = fakePeer("bob");
    const room = store.createRoom(alice);
    store.join(room, bob);
    expect(room.peers.size).toBe(2);
    expect(bobMsgs).toEqual([]); // join() itself doesn't message; server.ts sends "joined"
  });

  it("rejects a third peer with a full room", () => {
    const store = new RoomStore();
    const { peer: alice } = fakePeer("alice");
    const { peer: bob } = fakePeer("bob");
    const { peer: carol } = fakePeer("carol");
    const room = store.createRoom(alice);
    store.join(room, bob);
    expect(() => store.join(room, carol)).toThrow("full");
  });

  it("destroys the room when a peer leaves", () => {
    const store = new RoomStore();
    const { peer: alice } = fakePeer("alice");
    const { peer: bob } = fakePeer("bob");
    const room = store.createRoom(alice);
    store.join(room, bob);
    store.leave(room.id, "alice");
    expect(store.getById(room.id)).toBeUndefined();
    expect(store.getByCode(room.code)).toBeUndefined();
  });

  it("expires an unpaired room after the waiting TTL and notifies the creator", () => {
    const store = new RoomStore();
    const { peer: alice, messages } = fakePeer("alice");
    const room = store.createRoom(alice);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(store.getById(room.id)).toBeUndefined();
    expect(messages.some((m) => m.type === "error" && m.code === "room-expired")).toBe(true);
  });

  it("does not expire a room on the waiting timer once it has been paired", () => {
    const store = new RoomStore();
    const { peer: alice } = fakePeer("alice");
    const { peer: bob } = fakePeer("bob");
    const room = store.createRoom(alice);
    vi.advanceTimersByTime(5 * 60 * 1000);
    store.join(room, bob);
    vi.advanceTimersByTime(6 * 60 * 1000); // past the original 10-minute waiting TTL
    expect(store.getById(room.id)).toBe(room);
  });

  describe("disconnect grace / rejoin (network-change recovery)", () => {
    it("keeps a paired room alive and notifies the other peer on an unexpected disconnect", () => {
      const store = new RoomStore();
      const { peer: alice } = fakePeer("alice");
      const { peer: bob, messages: bobMsgs } = fakePeer("bob");
      const room = store.createRoom(alice);
      store.join(room, bob);

      const { otherPeer, graceMs } = store.disconnectPeer(room.id, "alice", "conn-1");
      expect(otherPeer?.id).toBe("bob");
      expect(graceMs).toBeGreaterThan(0);
      expect(store.getById(room.id)).toBe(room); // still alive, not destroyed
      expect(bobMsgs).toEqual([]); // disconnectPeer itself doesn't message; server.ts sends "peer-disconnected"
    });

    it("destroys the room immediately if the disconnecting peer was never paired with anyone", () => {
      const store = new RoomStore();
      const { peer: alice } = fakePeer("alice");
      const room = store.createRoom(alice);

      store.disconnectPeer(room.id, "alice", "conn-1");
      expect(store.getById(room.id)).toBeUndefined();
    });

    it("lets a disconnected peer rejoin within the grace window and notifies the other peer", () => {
      const store = new RoomStore();
      const { peer: alice } = fakePeer("alice");
      const { peer: bob, messages: bobMsgs } = fakePeer("bob");
      const room = store.createRoom(alice);
      store.join(room, bob);

      store.disconnectPeer(room.id, "alice", "conn-1");
      vi.advanceTimersByTime(5 * 1000); // well within the 20s grace window

      const { peer: aliceReconnected } = fakePeer("alice");
      const result = store.rejoin(room.id, "alice", aliceReconnected);
      expect(result.ok).toBe(true);
      expect(result.otherPeer?.id).toBe("bob");

      // The grace timer must be cancelled — advancing well past it shouldn't destroy the room.
      vi.advanceTimersByTime(30 * 1000);
      expect(store.getById(room.id)).toBe(room);
      expect(bobMsgs).toEqual([]); // rejoin() itself doesn't message; server.ts sends "peer-reconnected"
    });

    it("destroys the room and tells the remaining peer if the grace window expires without a rejoin", () => {
      const store = new RoomStore();
      const { peer: alice } = fakePeer("alice");
      const { peer: bob, messages: bobMsgs } = fakePeer("bob");
      const room = store.createRoom(alice);
      store.join(room, bob);

      store.disconnectPeer(room.id, "alice", "conn-1");
      vi.advanceTimersByTime(21 * 1000); // past the 20s grace window

      expect(store.getById(room.id)).toBeUndefined();
      expect(bobMsgs.some((m) => m.type === "peer-left" && m.peerId === "alice")).toBe(true);
    });

    it("ignores a stale disconnectPeer from a connection already superseded by a rejoin", () => {
      // Simulates: alice's old socket goes offline, she rejoins on a NEW
      // socket (conn-2) before the OLD socket's (conn-1) close event is ever
      // noticed by the server — e.g. it died without a clean TCP close while
      // offline. That late close must not tear down the live reconnection.
      const store = new RoomStore();
      const { peer: aliceOld } = fakePeer("alice", "conn-1");
      const { peer: bob, messages: bobMsgs } = fakePeer("bob");
      const room = store.createRoom(aliceOld);
      store.join(room, bob);

      store.disconnectPeer(room.id, "alice", "conn-1");
      const { peer: aliceNew } = fakePeer("alice", "conn-2");
      const rejoinResult = store.rejoin(room.id, "alice", aliceNew);
      expect(rejoinResult.ok).toBe(true);

      // The old connection's close event finally arrives, late.
      const staleResult = store.disconnectPeer(room.id, "alice", "conn-1");
      expect(staleResult.otherPeer).toBeUndefined();
      expect(store.getById(room.id)).toBe(room); // still alive
      expect(room.peers.has("alice")).toBe(true); // the NEW connection is untouched

      // And the grace timer from the stale call must not later destroy the room either.
      vi.advanceTimersByTime(25 * 1000);
      expect(store.getById(room.id)).toBe(room);
      expect(bobMsgs.some((m) => m.type === "peer-left")).toBe(false);
    });

    it("rejects a rejoin for an unknown peerId or an already-destroyed room", () => {
      const store = new RoomStore();
      const { peer: alice } = fakePeer("alice");
      const { peer: bob } = fakePeer("bob");
      const room = store.createRoom(alice);
      store.join(room, bob);
      store.disconnectPeer(room.id, "alice", "conn-1");

      const { peer: mallory } = fakePeer("mallory");
      expect(store.rejoin(room.id, "mallory", mallory).ok).toBe(false);
      expect(store.rejoin("not-a-real-room", "alice", mallory).ok).toBe(false);
    });
  });
});
