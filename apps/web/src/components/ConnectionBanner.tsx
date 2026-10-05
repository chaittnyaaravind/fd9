import type { ConnectionPhase } from "../state/session.js";
import type { ConnectionStage, LinkQuality } from "../lib/rtc.js";

interface Props {
  phase: ConnectionPhase;
  linkQuality: LinkQuality;
  wakeLockActive: boolean;
  errorMessage: string | null;
  /** Real, diagnostics-derived stage of the INITIAL attempt (see rtc.ts's deriveConnectionStage) — only consulted while phase === "connecting"; never fabricated independently of it. */
  connectionStage: ConnectionStage;
}

function describe(phase: ConnectionPhase, linkQuality: LinkQuality, connectionStage: ConnectionStage): { label: string; cls: string } {
  switch (phase) {
    case "idle":
      return { label: "Idle", cls: "" };
    case "waiting-for-peer":
      return { label: "Waiting for the other device to connect…", cls: "" };
    case "connecting":
      switch (connectionStage) {
        case "preparing":
          return { label: "Preparing connection…", cls: "" };
        case "trying-direct":
          return { label: "Trying direct connection…", cls: "" };
        case "falling-back-to-relay":
          return { label: "Direct connection unavailable — using secure relay…", cls: "is-relayed" };
      }
    case "reconnecting":
      return { label: "Reconnecting…", cls: "is-relayed" };
    case "connected":
      if (linkQuality === "relayed") return { label: "Connected via relay (TURN) — your network blocked a direct link", cls: "is-relayed" };
      if (linkQuality === "direct") return { label: "Connected directly, peer-to-peer", cls: "is-direct" };
      return { label: "Connected — confirming route…", cls: "" };
    case "transferring":
      if (linkQuality === "relayed") return { label: "Transferring via relay (TURN)", cls: "is-relayed" };
      if (linkQuality === "direct") return { label: "Transferring, connected directly", cls: "is-direct" };
      return { label: "Transferring…", cls: "" };
    case "completed":
      return { label: "Transfer complete", cls: "is-connected" };
    case "failed":
      return { label: "Connection failed", cls: "is-failed" };
    case "closed":
      return { label: "Session closed", cls: "" };
  }
}

export function ConnectionBanner({ phase, linkQuality, wakeLockActive, errorMessage, connectionStage }: Props) {
  const { label, cls } = describe(phase, linkQuality, connectionStage);
  return (
    <div className={`banner ${cls}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        {errorMessage ? ` — ${errorMessage}` : null}
        {phase === "transferring" && !wakeLockActive ? " · Keep this tab open and your screen on." : null}
      </span>
    </div>
  );
}
