import type { ConnectionPhase } from "../state/session.js";
import type { LinkQuality } from "../lib/rtc.js";

interface Props {
  phase: ConnectionPhase;
  linkQuality: LinkQuality;
  wakeLockActive: boolean;
  errorMessage: string | null;
}

function describe(phase: ConnectionPhase, linkQuality: LinkQuality): { label: string; cls: string } {
  switch (phase) {
    case "idle":
      return { label: "Idle", cls: "" };
    case "waiting-for-peer":
      return { label: "Waiting for the other device to connect…", cls: "" };
    case "connecting":
      return { label: "Connecting…", cls: "" };
    case "reconnecting":
      return { label: "Reconnecting…", cls: "is-relayed" };
    case "connected":
      return linkQuality === "relayed"
        ? { label: "Connected via relay (TURN) — your network blocked a direct link", cls: "is-relayed" }
        : { label: "Connected directly, peer-to-peer", cls: "is-direct" };
    case "transferring":
      return linkQuality === "relayed"
        ? { label: "Transferring via relay (TURN)", cls: "is-relayed" }
        : { label: "Transferring, connected directly", cls: "is-direct" };
    case "completed":
      return { label: "Transfer complete", cls: "is-connected" };
    case "failed":
      return { label: "Connection failed", cls: "is-failed" };
    case "closed":
      return { label: "Session closed", cls: "" };
  }
}

export function ConnectionBanner({ phase, linkQuality, wakeLockActive, errorMessage }: Props) {
  const { label, cls } = describe(phase, linkQuality);
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
