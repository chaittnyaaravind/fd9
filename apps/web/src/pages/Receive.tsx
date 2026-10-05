import { useEffect, useState } from "react";
import { ApprovalDialog } from "../components/ApprovalDialog.js";
import { ConnectionBanner } from "../components/ConnectionBanner.js";
import { CompletionScreen } from "../components/CompletionScreen.js";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel.js";
import { FileQueue } from "../components/FileQueue.js";
import { OverallProgress } from "../components/OverallProgress.js";
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
        <div className="eyebrow">Receive files</div>
        <h1 className="hero-title" style={{ fontSize: "2rem" }}>
          Enter the code
        </h1>
        <form onSubmit={join}>
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABC123"
            maxLength={8}
            autoFocus
            aria-label="Room code"
          />
          <button className="btn btn-primary" type="submit" style={{ width: "100%", marginTop: "var(--space-4)" }} disabled={code.trim().length < 4}>
            Join session
          </button>
        </form>
        <button className="btn btn-secondary" style={{ marginTop: "var(--space-4)" }} onClick={onExit}>
          Back
        </button>
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
      {state.incomingOffer ? (
        <ApprovalDialog offer={state.incomingOffer} onDecide={state.acceptIncoming} />
      ) : null}
      {state.files.length > 0 ? (
        <>
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
