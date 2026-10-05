import { Reveal } from "../components/Reveal.js";

const STAGES = [
  {
    n: "01",
    title: "Signaling",
    body: "Two browsers open a WebSocket to a small signaling server and exchange a room code or QR code. The server's only job is introducing two browsers to each other — it relays connection-setup messages (SDP offers/answers, ICE candidates) but never sees file names, file bytes, or transfer progress."
  },
  {
    n: "02",
    title: "ICE & STUN",
    body: "Each browser gathers its own candidate network paths (ICE) — its local address, and its public-facing address discovered via a STUN server. These candidates are exchanged over the signaling connection so each side knows how the other might be reachable."
  },
  {
    n: "03",
    title: "Direct, or TURN relay",
    body: "The browsers' own ICE agents try every candidate pair and pick whichever path actually connects — direct peer-to-peer when NAT/firewall rules allow it, or a TURN relay server when they don't. This selection happens automatically, using real connectivity evidence, never a guess."
  },
  {
    n: "04",
    title: "DataChannels",
    body: "Once a path is selected, an encrypted WebRTC DataChannel carries the file in chunks sized to exactly what this specific connection's SCTP transport actually supports — with backpressure so the sender never overruns what the network or the receiver can absorb."
  },
  {
    n: "05",
    title: "Integrity verification",
    body: "An incremental SHA-256 hash runs on both sides as bytes move. The sender doesn't declare a transfer complete just because its local send buffer emptied — the spec is explicit that only means the data was handed to the network, not that the other side has it. Completion requires the receiver's own explicit confirmation of every byte and a matching hash."
  },
  {
    n: "06",
    title: "Reconnect & resume",
    body: "Wi-Fi drops, cellular handoffs, and brief network loss are treated as normal, not exceptional. If a connection is interrupted mid-transfer, FD9 resumes from the receiver's last confirmed byte offset — not from zero — once connectivity returns."
  }
];

export function HowItWorksPage() {
  return (
    <div className="container container-wide">
      <Reveal>
        <div className="eyebrow">How it works</div>
      </Reveal>
      <Reveal delay={60}>
        <h1 className="hero-title" style={{ fontSize: "clamp(2rem, 3vw + 1rem, 2.75rem)" }}>
          The engineering underneath
        </h1>
      </Reveal>
      <Reveal delay={120}>
        <p className="hero-sub">
          FD9 looks simple on the surface — a code, a connection, a transfer. Underneath, it's a real WebRTC
          implementation handling signaling, NAT traversal, backpressure, and integrity verification the way the
          spec actually requires, not the way it's easy to assume it works.
        </p>
      </Reveal>

      <Reveal delay={160}>
        <pre className="hiw-diagram" aria-label="Architecture diagram">
{`Device A                                Device B
   │                                        │
   │  WebSocket (signaling, relays setup)   │
   │<──────────────────────────────────────>│
   │                                        │
   │  ICE candidates, STUN-discovered addrs │
   │<──────────────────────────────────────>│
   │                                        │
   │         Direct P2P ── when possible    │
   │  ═══════════════════════════════════►  │
   │         TURN relay ── when necessary   │
   │  ───[ relay server ]─────────────────► │
   │                                        │
   │   Encrypted WebRTC DataChannel          │
   │   chunked · backpressured · hashed     │
   │  ═══════════════════════════════════►  │
   │                                        │
   │   Receiver-confirmed completion        │
   │<══════════════════════════════════════ │`}
        </pre>
      </Reveal>

      <section className="section">
        <div className="steps">
          {STAGES.map((s, i) => (
            <Reveal key={s.n} delay={i * 70} className="step" direction={i % 2 ? "right" : "left"}>
              <div className="step-n">{s.n}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </Reveal>
          ))}
        </div>
      </section>
    </div>
  );
}
