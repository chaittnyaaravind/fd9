import type { ConnectionDiagnostics } from "../lib/rtc.js";

interface Props {
  diagnostics: ConnectionDiagnostics;
  sustainedMBs: number;
}

/** Binary MiB/s -> decimal Mbps — the unit WebRTC/network tooling actually reports in. */
function toMbps(mbs: number): number {
  return mbs * 8 * ((1024 * 1024) / 1_000_000);
}

function relayLabel(protocol: ConnectionDiagnostics["selectedRelayProtocol"]): string {
  if (protocol === "tls") return "TURN TLS";
  if (protocol === "tcp") return "TURN TCP";
  if (protocol === "udp") return "TURN UDP";
  return "Relay";
}

/**
 * The primary, always-visible connection indicator (spec section 4) — a
 * deliberately simple evidence-based readout, never a claim unsupported by
 * real diagnostics. "Direct" is only ever shown when getStats() actually
 * selected a host/srflx pair; the exact relay transport only ever comes
 * from the real selected candidate's relayProtocol, never guessed. The
 * deeper, advanced breakdown (ICE state, candidate counts, errors, etc.)
 * stays in DiagnosticsPanel's hidden-by-default <details> — this component
 * is what a normal, non-technical user actually looks at.
 */
export function ConnectionIndicator({ diagnostics, sustainedMBs }: Props) {
  if (!diagnostics.hasSelectedPair) return null;

  const isDirect = diagnostics.quality === "direct";
  const mbps = sustainedMBs > 0 ? toMbps(sustainedMBs) : null;

  return (
    <div className={`conn-indicator${isDirect ? " is-direct" : " is-relayed"}`}>
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-indicator-text">
        <strong>{isDirect ? "Direct connection" : "Relay connection"}</strong>
        {!isDirect ? <span className="conn-indicator-sub">{relayLabel(diagnostics.selectedRelayProtocol)}</span> : null}
      </span>
      {mbps !== null ? <span className="conn-indicator-speed">{mbps.toFixed(1)} Mbps</span> : null}
    </div>
  );
}
