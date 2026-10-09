/**
 * FD9's own hero already proves "two devices, a stream of data between
 * them" live on fd9.tech (TransferVisual.tsx) — this is a smaller, static
 * restatement of that same real idea for the project card, not a new 3D
 * scene. Reusing a proven, cheap pattern here is the honest choice: FD9
 * already looks like this in production.
 */
export function ProjectVisualFD9() {
  return (
    <div className="pv-fd9" aria-hidden="true">
      <div className="pv-fd9-device pv-fd9-device-a" />
      <div className="pv-fd9-link">
        <span className="pv-fd9-packet" />
        <span className="pv-fd9-packet p2" />
        <span className="pv-fd9-packet p3" />
      </div>
      <div className="pv-fd9-device pv-fd9-device-b" />
    </div>
  );
}
