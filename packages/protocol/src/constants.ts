/**
 * Shared tunables for signaling and transfer. Values chosen conservatively
 * against known browser/SCTP limits; the client benchmarks around these
 * defaults rather than assuming them optimal (see web/src/lib/chunking.ts).
 */

/** Fallback chunk size when the real negotiated SCTP max-message-size can't be read. */
export const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KiB — safe under all browsers' SCTP message-size ceilings

/** Smallest and largest chunk sizes the per-connection sizing in rtc.ts may pick. */
export const MIN_CHUNK_SIZE = 4 * 1024;
export const MAX_CHUNK_SIZE = 256 * 1024;

/**
 * Bound on in-flight (sent, unacked-by-bufferedamount) bytes before pausing reads.
 *
 * Throughput over any buffered, windowed transport is bounded by roughly
 * `window / RTT` (Little's Law) — a 1 MiB window over a 150-300ms RTT (any
 * TURN-relayed or long-distance path) caps throughput at single-digit MB/s
 * no matter how fast the underlying link actually is. The real fix for the
 * original "send queue is full" crash is sender.ts's check-BEFORE-send plus
 * a catch-and-retry around send() itself — those make hitting the browser's
 * own internal ceiling a handled, non-fatal event regardless of window size.
 * With that safety net in place, the window can (and should) be generous
 * for real throughput; it was never the window size that caused the crash.
 */
export const BUFFERED_AMOUNT_HIGH_WATERMARK = 8 * 1024 * 1024; // 8 MiB
export const BUFFERED_AMOUNT_LOW_WATERMARK = 2 * 1024 * 1024; // 2 MiB — fires `bufferedamountlow`

/**
 * If `send()` itself throws (e.g. "RTCDataChannel send queue is full" — the
 * browser's own backpressure signal, not a fatal error), retry with this
 * bounded backoff instead of aborting the whole file.
 */
export const SEND_RETRY_DELAYS_MS = [20, 50, 100, 250, 500, 1000, 1000, 1000, 1000, 1000];

/** Receiver sends a chunk-ack at most this often, to keep the control channel light. */
export const ACK_INTERVAL_MS = 250;
export const ACK_BYTE_INTERVAL = 1 * 1024 * 1024; // or every 1 MiB received, whichever comes first

/**
 * Receiver-side STORAGE backpressure — distinct from, and in addition to,
 * the sender's own `BUFFERED_AMOUNT_*` watermarks above. Those only bound
 * the sender's un-transmitted send buffer; they have zero visibility into
 * how fast the receiver can actually persist what it has already received
 * (one real IndexedDB transaction commit per `FLUSH_BYTES`, or disk I/O via
 * File System Access). Once bytes leave the sender's buffer, the browser's
 * SCTP stack hands them to the receiver's `onmessage` as fast as the wire
 * allows, fully decoupled from `sink.write()` throughput. Without a cap
 * here, the receiver has no way to ever tell the sender "catch up" — raw
 * ArrayBuffers from arrived-but-not-yet-written chunks pile up without
 * bound (held alive by the ordering-preserving write queue), causing GC
 * thrashing that looks like a hang long before any crash. This watermark
 * pair closes that loop over the already-existing pause/resume control
 * messages: the receiver pauses the sender once too many received bytes
 * are still waiting on a durable write, and resumes once storage catches
 * back up.
 */
export const RECEIVE_BACKPRESSURE_HIGH_WATERMARK = 16 * 1024 * 1024; // 16 MiB received-but-unwritten before pausing the sender
export const RECEIVE_BACKPRESSURE_LOW_WATERMARK = 4 * 1024 * 1024; // resume once the backlog drains to this

/** In-memory fallback cap when File System Access streaming isn't available. */
export const MEMORY_FALLBACK_MAX_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB

/** Room / pairing lifecycle. */
export const ROOM_CODE_LENGTH = 6; // human-typeable short code, excludes ambiguous chars
export const ROOM_ID_BYTES = 18; // crypto-random id encoded as base64url, used in shareable links
export const ROOM_TTL_MS = 10 * 60 * 1000; // ephemeral room expires 10 min after creation if unpaired
export const SESSION_TTL_MS = 30 * 60 * 1000; // paired session hard cap
/** Grace window a paired room stays alive after a peer's WebSocket drops, for network-change recovery (Wi-Fi<->cellular). */
export const RECONNECT_GRACE_MS = 20 * 1000;

/** Pairing rate limiting (per source IP). */
export const JOIN_ATTEMPTS_PER_WINDOW = 8;
export const JOIN_WINDOW_MS = 60 * 1000;
export const ROOM_CREATE_PER_WINDOW = 20;
export const ROOM_CREATE_WINDOW_MS = 60 * 1000;

/** Hard caps enforced by both peers and the signaling server. */
export const MAX_FILES_PER_OFFER = 200;
export const MAX_FILENAME_LENGTH = 255;
export const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024;

/** Binary chunk frame layout: [fileIndex: u16][offset: f64][length: u32][payload...] */
export const CHUNK_HEADER_BYTES = 2 + 8 + 4;
