/**
 * The ONE canonical result shape for any FD9 transport benchmark (Milestone
 * 1, item 4). Exists so every future A/B — TURN UDP vs TCP vs TLS, Azure vs
 * a managed provider, WebRTC vs a future transport — produces directly
 * comparable records instead of each experiment inventing its own ad hoc
 * table (which is what happened across this project's earlier investigation
 * phases). Field names/semantics are drawn from what pc-scaling-bench.js and
 * rtc.ts's ConnectionDiagnostics already measure for real — this schema
 * does not invent any new measurement, only a consistent shape for ones
 * that already exist.
 *
 * `null` means "not measured/not exposed by this transport" — never a
 * fabricated value. Example: `retransmittedBytes` is not a standard
 * RTCIceCandidatePairStats field for pure SCTP DataChannel transport, so a
 * WebRTC result reports it as null rather than guessing.
 */
export interface BenchmarkResult {
  /** ISO 8601 — when this run completed. */
  timestamp: string;
  /** Free-text device label (e.g. "Mac" / "iPhone") — never guessed from a UA string beyond what it actually says. */
  device: string;
  /** navigator.userAgent, verbatim — the full detail, not a parsed guess. */
  browser: string;
  /** navigator.platform, verbatim. */
  os: string;
  /** Free-text network label the OPERATOR supplies (e.g. "eduroam", "SJSU Guest") — FD9 cannot reliably detect this itself, so it is never inferred. */
  network: string;
  /** Which transport path this run actually used — set from real ICE/candidate evidence, never assumed from which URL list was offered. */
  transport: "direct" | "turn-udp" | "turn-tcp" | "turn-tls" | "webtransport";
  /** TURN/relay provider name, or null for a direct run. */
  provider: string | null;
  relayProtocol: string | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  rttMs: number | null;
  requestedBytes: number;
  /** Bytes actually confirmed delivered — only equals requestedBytes on a genuinely verified run (see `verified`/`integrity`). */
  actualBytes: number;
  /** Raw transport-layer bytes sent (includes framing/SCTP/ICE overhead) — always >= actualBytes. */
  transportBytesSent: number;
  chunkBytes: number;
  durationMs: number;
  averageMBps: number;
  peakMBps: number;
  /** Not a standard field for pure DataChannel/SCTP transport — null on every WebRTC result until/unless a future transport actually exposes it. */
  retransmittedBytes: number | null;
  /** Not exposed by getStats() for SCTP DataChannel transport today — null on every WebRTC result. */
  packetsLost: number | null;
  verified: boolean;
  integrity: "verified" | "failed" | "not-attempted";
}

/** navigator.userAgent/platform are real, available data — never a guess about what they mean beyond their literal value. */
export function detectBrowserOs(): { browser: string; os: string } {
  if (typeof navigator === "undefined") return { browser: "unknown", os: "unknown" };
  return { browser: navigator.userAgent, os: navigator.platform || "unknown" };
}
