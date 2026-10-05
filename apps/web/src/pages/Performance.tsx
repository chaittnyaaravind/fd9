import { Reveal } from "../components/Reveal.js";

/**
 * Real results measured during this project's development — NOT a live
 * benchmark, NOT fabricated. Each row is one real physical Mac<->iPhone
 * transfer over the actual production transport (SenderEngine/
 * ReceiverEngine/TransportPool), hash-verified, with the fields the
 * project's own BenchmarkResult schema defines (see
 * apps/web/src/lib/benchmarkResult.ts). Kept as a static, clearly-labeled
 * snapshot rather than wired to a live-running benchmark, since running a
 * real TURN transfer from a public marketing page would mean exposing
 * TURN credentials and pairing UI to every visitor — out of scope for what
 * this page is for.
 */
interface ResultRow {
  label: string;
  lanes: number;
  transport: "Direct (STUN)" | "TURN UDP";
  requestedBytes: number;
  actualBytes: number;
  verified: boolean;
  rttMs: number | null;
  avgMBps: number | null;
  peakMBps: number | null;
}

const RESULTS: ResultRow[] = [
  { label: "1 independent connection", lanes: 1, transport: "TURN UDP", requestedBytes: 268435456, actualBytes: 268435456, verified: true, rttMs: 85, avgMBps: 1.42, peakMBps: 3.44 },
  { label: "2 independent connections", lanes: 2, transport: "TURN UDP", requestedBytes: 268435456, actualBytes: 268435456, verified: true, rttMs: 87, avgMBps: 1.50, peakMBps: 15.41 },
  { label: "4 independent connections", lanes: 4, transport: "TURN UDP", requestedBytes: 268435456, actualBytes: 268435456, verified: true, rttMs: 57, avgMBps: 1.49, peakMBps: 19.20 },
  { label: "8 independent connections", lanes: 8, transport: "TURN UDP", requestedBytes: 268435456, actualBytes: 268435456, verified: true, rttMs: 55, avgMBps: 1.41, peakMBps: 18.67 },
  { label: "Direct peer-to-peer", lanes: 1, transport: "Direct (STUN)", requestedBytes: 268435456, actualBytes: 0, verified: false, rttMs: null, avgMBps: null, peakMBps: null }
];

function fmtBytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(0)} MiB`;
}

export function PerformancePage() {
  return (
    <div className="container container-wide">
      <Reveal>
        <div className="eyebrow">Performance</div>
      </Reveal>
      <Reveal delay={60}>
        <h1 className="hero-title" style={{ fontSize: "clamp(2rem, 3vw + 1rem, 2.75rem)" }}>
          Real measured results
        </h1>
      </Reveal>
      <Reveal delay={120}>
        <p className="hero-sub">
          Every number below is from an actual physical Mac ↔ iPhone transfer over the real production transport —
          not simulated, not estimated. Each run moved an exact 256 MiB payload and was hash-verified end to end.
        </p>
      </Reveal>

      <Reveal delay={160}>
        <div className="perf-env-label">Environment: Azure self-hosted TURN relay · physical Mac ↔ iPhone · real institutional/cellular networks</div>
      </Reveal>

      <Reveal delay={200}>
        <div className="perf-table-wrap">
          <table className="perf-table">
            <thead>
              <tr>
                <th>Configuration</th>
                <th>Transport</th>
                <th>Requested</th>
                <th>Delivered</th>
                <th>Verified</th>
                <th>RTT</th>
                <th>Avg</th>
                <th>Peak</th>
              </tr>
            </thead>
            <tbody>
              {RESULTS.map((r) => (
                <tr key={r.label} className={r.verified ? "" : "perf-row-failed"}>
                  <td>{r.label}</td>
                  <td>{r.transport}</td>
                  <td>{fmtBytes(r.requestedBytes)}</td>
                  <td>{fmtBytes(r.actualBytes)}</td>
                  <td>{r.verified ? "✓ yes" : "✗ failed to connect"}</td>
                  <td>{r.rttMs !== null ? `${r.rttMs} ms` : "—"}</td>
                  <td>{r.avgMBps !== null ? `${r.avgMBps.toFixed(2)} MiB/s` : "—"}</td>
                  <td>{r.peakMBps !== null ? `${r.peakMBps.toFixed(2)} MiB/s` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>

      <Reveal delay={240}>
        <div className="perf-note">
          <p>
            <strong>Adding more independent connections increased peak throughput substantially (3.4 → 19.2 MiB/s)
            but not sustained average throughput (~1.4–1.5 MiB/s across every lane count).</strong> That's real
            evidence the relay server itself wasn't the bottleneck — on this specific network and device pair, the
            ceiling sat somewhere else in the path. Direct peer-to-peer could not establish on any of the real
            networks tested so far (institutional Wi-Fi, cellular, campus guest networks all blocked it) — TURN
            relay is currently the only working path for this device pairing.
          </p>
          <p>
            <strong>These numbers describe this specific test environment, not FD9's maximum possible speed.</strong>{" "}
            Performance depends heavily on network topology — the physical link, NAT/firewall behavior, and the relay
            server's own capacity all shape the result. A direct peer-to-peer connection on a network that permits
            it, or a different relay deployment, would produce different numbers.
          </p>
        </div>
      </Reveal>
    </div>
  );
}
