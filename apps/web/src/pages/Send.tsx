import { ConnectionBanner } from "../components/ConnectionBanner.js";
import { ConnectionIndicator } from "../components/ConnectionIndicator.js";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel.js";
import { Dropzone } from "../components/Dropzone.js";
import { FileQueue } from "../components/FileQueue.js";
import { OverallProgress } from "../components/OverallProgress.js";
import { TransferProgressVisual } from "../components/TransferProgressVisual.js";
import { QrPairing } from "../components/QrPairing.js";
import { CompletionScreen } from "../components/CompletionScreen.js";
import { useSessionStore } from "../state/session.js";

interface Props {
  onExit: () => void;
}

export function SendPage({ onExit }: Props) {
  const state = useSessionStore();
  // Derived from global phase, not separate local state — a send flow
  // started by anything other than the Dropzone (e.g. benchmark mode's
  // startSendingBenchmark, triggered directly on the store) must still
  // correctly leave the picker screen, not just the in-component click path.
  const picked = state.phase !== "idle";

  async function handleFiles(files: File[]) {
    await state.startSending(files);
  }

  if (!picked) {
    return (
      <div className="container">
        <div className="eyebrow">Send files</div>
        <h1 className="hero-title" style={{ fontSize: "2rem" }}>
          Choose what to send
        </h1>
        <Dropzone onFiles={handleFiles} />
        <button className="btn btn-secondary" style={{ marginTop: "var(--space-5)" }} onClick={onExit}>
          Back
        </button>
      </div>
    );
  }

  if (state.phase === "completed") {
    return (
      <div className="container">
        <CompletionScreen role="sender" readyFiles={state.readyFiles} files={state.files} onStartOver={onExit} />
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
      {state.phase === "waiting-for-peer" ? <QrPairing code={state.roomCode} link={state.roomLink} /> : null}
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
