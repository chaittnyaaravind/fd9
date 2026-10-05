import { describe, expect, it } from "vitest";
import {
  clientMessageSchema,
  controlMessageSchema,
  decodeChunkFrame,
  encodeChunkFrame,
  roomCodeSchema,
  serverMessageSchema
} from "../src/index.js";

describe("roomCodeSchema", () => {
  it("accepts a well-formed code", () => {
    expect(roomCodeSchema.safeParse("7K4P9Q").success).toBe(true);
  });
  it("rejects lowercase or short codes", () => {
    expect(roomCodeSchema.safeParse("abc").success).toBe(false);
    expect(roomCodeSchema.safeParse("ab").success).toBe(false);
  });
});

describe("clientMessageSchema", () => {
  it("accepts create-room", () => {
    expect(clientMessageSchema.safeParse({ type: "create-room" }).success).toBe(true);
  });
  it("rejects join-room with neither roomId nor code", () => {
    expect(clientMessageSchema.safeParse({ type: "join-room" }).success).toBe(false);
  });
  it("accepts join-room with a code", () => {
    expect(clientMessageSchema.safeParse({ type: "join-room", code: "ABC123" }).success).toBe(true);
  });
  it("rejects an unknown message type", () => {
    expect(clientMessageSchema.safeParse({ type: "delete-everything" }).success).toBe(false);
  });
  it("rejects oversized SDP payloads", () => {
    const huge = "a".repeat(64 * 1024);
    expect(
      clientMessageSchema.safeParse({ type: "relay-sdp", payload: { type: "offer", sdp: huge } }).success
    ).toBe(false);
  });
});

describe("serverMessageSchema", () => {
  it("accepts a well-formed error message", () => {
    const result = serverMessageSchema.safeParse({
      type: "error",
      code: "room-not-found",
      message: "no such room"
    });
    expect(result.success).toBe(true);
  });
  it("rejects an unknown error code", () => {
    const result = serverMessageSchema.safeParse({
      type: "error",
      code: "totally-made-up",
      message: "x"
    });
    expect(result.success).toBe(false);
  });
});

describe("controlMessageSchema", () => {
  it("accepts a file-offer with files", () => {
    const result = controlMessageSchema.safeParse({
      type: "file-offer",
      files: [{ fileIndex: 0, name: "a.txt", size: 10, mimeType: "text/plain" }]
    });
    expect(result.success).toBe(true);
  });
  it("rejects a file-offer with zero files", () => {
    expect(controlMessageSchema.safeParse({ type: "file-offer", files: [] }).success).toBe(false);
  });
  it("rejects a malformed sha256 hex", () => {
    const result = controlMessageSchema.safeParse({
      type: "file-trailer",
      fileIndex: 0,
      sha256Hex: "not-hex"
    });
    expect(result.success).toBe(false);
  });
});

describe("chunk frame encode/decode", () => {
  it("round-trips a chunk exactly", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]);
    const frame = encodeChunkFrame(3, 1_234_567, payload);
    const decoded = decodeChunkFrame(frame);
    expect(decoded.fileIndex).toBe(3);
    expect(decoded.byteOffset).toBe(1_234_567);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  it("round-trips an empty payload (empty-file chunk)", () => {
    const frame = encodeChunkFrame(0, 0, new Uint8Array(0));
    const decoded = decodeChunkFrame(frame);
    expect(decoded.payload.byteLength).toBe(0);
  });

  it("round-trips a large byte offset beyond 32-bit range", () => {
    const bigOffset = 5 * 1024 * 1024 * 1024; // 5 GiB
    const frame = encodeChunkFrame(1, bigOffset, new Uint8Array([9]));
    expect(decodeChunkFrame(frame).byteOffset).toBe(bigOffset);
  });
});
