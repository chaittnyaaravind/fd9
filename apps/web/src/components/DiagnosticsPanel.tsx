import type { ConnectionDiagnostics } from "../lib/rtc.js";
import type { SignalingState } from "../lib/signalingClient.js";

interface Props {
  forcedRelay: boolean;
  signalingState: SignalingState | "idle";
  diagnostics: ConnectionDiagnostics;
  controlChannelState: RTCDataChannelState | "none";
  dataChannelState: RTCDataChannelState | "none";
  bufferedAmount: number;
  chunkSize: number | null;
  connectionTimeline: { t: number; label: string }[];
  /** Derived from the existing confirmedBytes progress stream — see session.ts's recordThroughputSample. Real measurements, never fabricated. */
  sustainedMBs: number;
  peakMBs: number;
}

function formatClock(t: number): string {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="diag-row">
      <span className="diag-label">{label}</span>
      <span className="diag-value">{value}</span>
    </div>
  );
}

/**
 * Hidden-by-default connection-internals panel (spec section 6). Every value
 * here comes straight from RTCPeerConnection/getStats() or the signaling
 * socket's real state — nothing here is inferred or guessed.
 */
export function DiagnosticsPanel({
  forcedRelay,
  signalingState,
  diagnostics,
  controlChannelState,
  dataChannelState,
  bufferedAmount,
  chunkSize,
  connectionTimeline,
  sustainedMBs,
  peakMBs
}: Props) {
  return (
    <details className="diagnostics-panel">
      <summary>Connection details{forcedRelay ? " — forced relay-only test" : ""}</summary>
      <div className="diag-grid">
        <Row label="Signaling" value={signalingState} />
        <Row label="ICE connection state" value={diagnostics.iceConnectionState} />
        <Row label="Connection state" value={diagnostics.connectionState} />
        <Row label="Selected candidate pair" value={diagnostics.hasSelectedPair ? "yes" : "not yet"} />
        <Row label="Local candidate type" value={diagnostics.localCandidateType ?? "—"} />
        <Row label="Remote candidate type" value={diagnostics.remoteCandidateType ?? "—"} />
        <Row label="TURN relay in use" value={diagnostics.quality === "relayed" ? "yes" : diagnostics.quality === "direct" ? "no" : "unknown"} />
        <Row
          label="Gathered candidates (host/srflx/relay)"
          value={`${diagnostics.localCandidateCounts.host} / ${diagnostics.localCandidateCounts.srflx} / ${diagnostics.localCandidateCounts.relay}`}
        />
        <Row label="RTT" value={diagnostics.rttMs !== null ? `${diagnostics.rttMs} ms` : "—"} />
        <Row label="Transport" value={diagnostics.localProtocol ?? "—"} />
        <Row label="Sustained throughput" value={sustainedMBs > 0 ? `${sustainedMBs.toFixed(2)} MiB/s` : "—"} />
        <Row label="Peak throughput" value={peakMBs > 0 ? `${peakMBs.toFixed(2)} MiB/s` : "—"} />
        <Row label="TURN UDP" value={diagnostics.turnTransports.udp} />
        <Row label="TURN TCP" value={diagnostics.turnTransports.tcp} />
        <Row label="TURN TLS (443)" value={diagnostics.turnTransports.tls} />
        <Row label="Control channel" value={controlChannelState} />
        <Row label="Data channel" value={dataChannelState} />
        <Row label="Buffered (unsent) amount" value={formatBytes(bufferedAmount)} />
        <Row label="Chunk size" value={chunkSize ? formatBytes(chunkSize) : "—"} />
      </div>
      {connectionTimeline.length > 0 ? (
        <div className="diag-timeline">
          <div className="diag-timeline-title">Connection timeline</div>
          <ol>
            {connectionTimeline.map((e, i) => (
              <li key={i}>
                <span className="diag-timeline-t">{formatClock(e.t)}</span> {e.label}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {diagnostics.iceCandidateErrors.length > 0 ? (
        <div className="diag-timeline">
          <div className="diag-timeline-title">ICE candidate errors</div>
          <ol>
            {diagnostics.iceCandidateErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </details>
  );
}
