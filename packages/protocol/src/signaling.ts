import { z } from "zod";
import { MAX_FILENAME_LENGTH } from "./constants.js";

/** A short, human-typeable pairing code (e.g. "7K4P9Q"). Not secret on its own — see security docs. */
export const roomCodeSchema = z.string().regex(/^[A-Z0-9]{4,8}$/);

/** High-entropy room id used in the shareable link; this is the real capability token. */
export const roomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,32}$/);

export const peerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,32}$/);

/**
 * `connectionId` is optional and absent = the session's PRIMARY
 * RTCPeerConnection (fully backward compatible — every message the
 * original single-connection protocol ever sent still parses and behaves
 * identically). A secondary bulk-transfer lane (its own independent
 * RTCPeerConnection/SCTP association, for genuine parallel throughput —
 * see apps/web/src/lib/transfer/peerLane.ts) tags its own offer/answer/
 * candidates with its own id so multiple negotiations can be multiplexed
 * over this same signaling connection without cross-talk. The signaling
 * SERVER never inspects this field — it already relays payloads opaquely.
 */
export const sdpPayloadSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().min(1).max(32 * 1024),
  connectionId: z.string().max(64).optional()
});

export const iceCandidatePayloadSchema = z.object({
  candidate: z.string().max(4 * 1024),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  connectionId: z.string().max(64).optional()
});

/** Messages a browser client sends to the signaling server. */
export const clientMessageSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("create-room") }),
    z.object({ type: z.literal("join-room"), roomId: roomIdSchema.optional(), code: roomCodeSchema.optional() }),
    z.object({ type: z.literal("leave-room") }),
    z.object({ type: z.literal("relay-sdp"), payload: sdpPayloadSchema }),
    z.object({ type: z.literal("relay-ice"), payload: iceCandidatePayloadSchema }),
    z.object({ type: z.literal("request-turn-credentials") }),
    z.object({ type: z.literal("ping") }),
    /** Resume a paired session on a new WebSocket (e.g. after a phone's Wi-Fi<->cellular switch dropped the old one). */
    z.object({ type: z.literal("rejoin-room"), roomId: roomIdSchema, peerId: peerIdSchema })
  ])
  .superRefine((value, ctx) => {
    if (value.type === "join-room" && !value.roomId && !value.code) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "roomId or code required" });
    }
  });
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const turnServerSchema = z.object({
  urls: z.array(z.string()).min(1),
  username: z.string().optional(),
  credential: z.string().optional()
});
export type TurnServer = z.infer<typeof turnServerSchema>;

/** Messages the signaling server sends to a browser client. */
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("room-created"),
    roomId: roomIdSchema,
    code: roomCodeSchema,
    peerId: peerIdSchema,
    expiresAt: z.number()
  }),
  z.object({ type: z.literal("joined"), roomId: roomIdSchema, peerId: peerIdSchema, isInitiator: z.boolean() }),
  z.object({ type: z.literal("peer-joined"), peerId: peerIdSchema }),
  z.object({ type: z.literal("peer-left"), peerId: peerIdSchema }),
  /** The other peer's WebSocket dropped but the room is holding a grace window for them to rejoin. */
  z.object({ type: z.literal("peer-disconnected"), peerId: peerIdSchema, graceMs: z.number() }),
  /** The other peer rejoined within the grace window — resume as if nothing happened (plus an ICE restart). */
  z.object({ type: z.literal("peer-reconnected"), peerId: peerIdSchema }),
  /** Ack for this client's own successful rejoin-room. */
  z.object({ type: z.literal("rejoined"), roomId: roomIdSchema, peerId: peerIdSchema, isInitiator: z.boolean() }),
  z.object({ type: z.literal("relay-sdp"), payload: sdpPayloadSchema }),
  z.object({ type: z.literal("relay-ice"), payload: iceCandidatePayloadSchema }),
  z.object({ type: z.literal("turn-credentials"), servers: z.array(turnServerSchema), ttlSeconds: z.number() }),
  z.object({
    type: z.literal("error"),
    code: z.enum([
      "room-not-found",
      "room-expired",
      "room-full",
      "invalid-code",
      "rate-limited",
      "bad-message",
      "origin-forbidden",
      "rejoin-failed"
    ]),
    message: z.string().max(500)
  }),
  z.object({ type: z.literal("pong") })
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Sanity bound reused by the server when validating an offered file's name. */
export const filenameSchema = z.string().min(1).max(MAX_FILENAME_LENGTH);
