import { z } from "zod";
import { MAX_FILENAME_LENGTH, MAX_FILES_PER_OFFER } from "./constants.js";

/**
 * Binary file bytes travel on a dedicated "data" RTCDataChannel as raw
 * ArrayBuffers framed as [fileIndex: u16][offset: f64][length: u32][payload].
 * Everything in this file is JSON control-channel traffic — metadata, state,
 * acks — kept on a separate "control" channel so it stays responsive even
 * while the data channel's send buffer is saturated with chunk bytes.
 */

export const offeredFileSchema = z.object({
  fileIndex: z.number().int().min(0),
  name: z.string().min(1).max(MAX_FILENAME_LENGTH),
  size: z.number().int().min(0),
  mimeType: z.string().max(255),
  lastModified: z.number().int().optional()
});
export type OfferedFile = z.infer<typeof offeredFileSchema>;

export const controlMessageSchema = z.discriminatedUnion("type", [
  // Sender -> Receiver: here's what I'd like to send; wait for explicit accept/reject.
  z.object({
    type: z.literal("file-offer"),
    files: z.array(offeredFileSchema).min(1).max(MAX_FILES_PER_OFFER)
  }),
  // Receiver -> Sender: per-file consent. `resumeFrom` covers DURABLE
  // resume — a file the receiver already has partial, persisted bytes of
  // from a PRIOR session (tab closed/reloaded, not just a live
  // reconnect — that case already resumes via transfer-start's own
  // resumeFromOffset). Matched by the receiver against its own persisted
  // transfer records before accepting; the sender re-hashes [0, offset)
  // without re-sending it, then sends only the remainder.
  z.object({
    type: z.literal("file-offer-response"),
    accepted: z.array(z.number().int().min(0)),
    rejected: z.array(z.number().int().min(0)),
    resumeFrom: z.array(z.object({ fileIndex: z.number().int().min(0), offset: z.number().int().min(0) })).optional()
  }),
  // Sender -> Receiver: starting this file now, with the chunk size it will use.
  z.object({
    type: z.literal("transfer-start"),
    fileIndex: z.number().int().min(0),
    chunkSize: z.number().int().min(1),
    resumeFromOffset: z.number().int().min(0).default(0)
  }),
  // Sender -> Receiver: final incremental hash once all bytes for a file were sent.
  z.object({
    type: z.literal("file-trailer"),
    fileIndex: z.number().int().min(0),
    sha256Hex: z.string().regex(/^[0-9a-f]{64}$/)
  }),
  // Receiver -> Sender: periodic confirmed-progress ack (bytes actually written, not just received).
  z.object({
    type: z.literal("chunk-ack"),
    fileIndex: z.number().int().min(0),
    confirmedBytes: z.number().int().min(0)
  }),
  // Receiver -> Sender: integrity verdict after comparing hashes.
  z.object({
    type: z.literal("file-complete"),
    fileIndex: z.number().int().min(0),
    ok: z.boolean(),
    sha256Hex: z.string().regex(/^[0-9a-f]{64}$/)
  }),
  // Either direction.
  z.object({ type: z.literal("pause"), fileIndex: z.number().int().min(0) }),
  z.object({ type: z.literal("resume"), fileIndex: z.number().int().min(0) }),
  z.object({
    type: z.literal("cancel"),
    fileIndex: z.number().int().min(0),
    reason: z.enum(["user", "error", "rejected"])
  }),
  z.object({ type: z.literal("session-complete") }),
  z.object({ type: z.literal("error"), message: z.string().max(500) })
]);
export type ControlMessage = z.infer<typeof controlMessageSchema>;

export const CHUNK_FRAME = {
  fileIndexOffset: 0,
  fileIndexBytes: 2,
  byteOffsetOffset: 2,
  byteOffsetBytes: 8,
  lengthOffset: 10,
  lengthBytes: 4,
  headerBytes: 14
} as const;

/** Packs a header + payload into a single ArrayBuffer for one `send()` call. */
export function encodeChunkFrame(fileIndex: number, byteOffset: number, payload: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(CHUNK_FRAME.headerBytes + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint16(CHUNK_FRAME.fileIndexOffset, fileIndex);
  view.setFloat64(CHUNK_FRAME.byteOffsetOffset, byteOffset);
  view.setUint32(CHUNK_FRAME.lengthOffset, payload.byteLength);
  new Uint8Array(buffer, CHUNK_FRAME.headerBytes).set(payload);
  return buffer;
}

export interface DecodedChunkFrame {
  fileIndex: number;
  byteOffset: number;
  payload: Uint8Array;
}

export function decodeChunkFrame(buffer: ArrayBuffer): DecodedChunkFrame {
  const view = new DataView(buffer);
  const fileIndex = view.getUint16(CHUNK_FRAME.fileIndexOffset);
  const byteOffset = view.getFloat64(CHUNK_FRAME.byteOffsetOffset);
  const length = view.getUint32(CHUNK_FRAME.lengthOffset);
  const payload = new Uint8Array(buffer, CHUNK_FRAME.headerBytes, length);
  return { fileIndex, byteOffset, payload };
}
