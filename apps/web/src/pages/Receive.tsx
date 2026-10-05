import { useEffect, useState } from "react";
import { Reveal } from "../components/Reveal.js";
import { IconDownload } from "../components/icons.js";
import { ApprovalDialog } from "../components/ApprovalDialog.js";
import { ConnectionBanner } from "../components/ConnectionBanner.js";
import { ConnectionIndicator } from "../components/ConnectionIndicator.js";
import { CompletionScreen } from "../components/CompletionScreen.js";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel.js";
import { FileQueue } from "../components/FileQueue.js";
import { OverallProgress } from "../components/OverallProgress.js";
import { TransferProgressVisual } from "../components/TransferProgressVisual.js";
import { useSessionStore } from "../state/session.js";

interface Props {
  initialRoomId: string | null;
  onExit: () => void;
}

export function ReceivePage({ initialRoomId, onExit }: Props) {
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(Boolean(initialRoomId));
  const state = useSessionStore();

  useEffect(() => {
    if (initialRoomId) void state.startReceiving({ roomId: initialRoomId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoomId]);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setJoining(true);
    await state.startReceiving({ code: code.trim().toUpperCase() });
  }

  if (!joining) {
    return (
      <div className="container">
        <Reveal>
          <div className="eyebrow">Receive files</div>
        </Reveal>
        <Reveal delay={60}>
          <h1 className="hero-title" style={{ fontSize: "2rem" }}>
            Enter the code
          </h1>
        </Reveal>
        <Reveal delay={120}>
          <p className="hero-sub" style={{ marginBottom: "var(--space-5)" }}>
            Ask the sender for the 6-character code shown on their screen, or scan their QR code to open this page
            pre-filled.
          </p>
        </Reveal>
        <Reveal delay={160}>
          <div className="receive-panel">
            <div className="receive-badge" aria-hidden="true">
              <IconDownload width={22} height={22} />
            </div>
            <form onSubmit={join} style={{ width: "100%" }}>
              <input
                className="code-input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABC123"
                maxLength={8}
                autoFocus
                aria-label="Room code"
              />
              <button
                className="btn btn-primary"
                type="submit"
                style={{ width: "100%", marginTop: "var(--space-4)" }}
                disabled={code.trim().length < 4}
              >
                Join session
              </button>
            </form>
          </div>
        </Reveal>
        <Reveal delay={200}>
          <button className="btn btn-secondary" style={{ marginTop: "var(--space-4)" }} onClick={onExit}>
            Back
          </button>
        </Reveal>
      </div>
    );
  }

  if (state.phase === "completed") {
    return (
      <div className="container">
        <CompletionScreen role="receiver" readyFiles={state.readyFiles} onStartOver={onExit} />
      </div>
    );
  }

  return (
    <div className="container">
      <ConnectionBanner
        phase={state.phase}
        linkQuality={state.linkQuality}
        wakeLockActive={state.wakeLockActive}
        errorMessage={state.errorMessage}
        connectionStage={state.connectionStage}
      />
      <ConnectionIndicator diagnostics={state.diagnostics} sustainedMBs={state.sustainedMBs} />
      {state.incomingOffer ? (
        <ApprovalDialog offer={state.incomingOffer} onDecide={state.acceptIncoming} />
      ) : null}
      {state.files.length > 0 ? (
        <>
          <TransferProgressVisual files={state.files} quality={state.diagnostics.quality} />
          <OverallProgress files={state.files} />
          <FileQueue files={state.files} onPause={state.pauseFile} onResume={state.resumeFile} onCancel={state.cancelFile} />
        </>
      ) : null}
      {state.phase !== "idle" && state.phase !== "waiting-for-peer" ? (
        <DiagnosticsPanel
          forcedRelay={state.forcedRelay}
          signalingState={state.signalingState}
          diagnostics={state.diagnostics}
          controlChannelState={state.controlChannelState}
          dataChannelState={state.dataChannelState}
          bufferedAmount={state.bufferedAmount}
          chunkSize={state.chunkSize}
          connectionTimeline={state.connectionTimeline}
          sustainedMBs={state.sustainedMBs}
          peakMBs={state.peakMBs}
        />
      ) : null}
      {state.phase === "failed" ? (
        <button className="btn btn-secondary" style={{ marginTop: "var(--space-5)" }} onClick={onExit}>
          Start over
        </button>
      ) : null}
    </div>
  );
}
