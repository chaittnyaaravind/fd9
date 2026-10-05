import { Reveal } from "../components/Reveal.js";
import { IconGithub } from "../components/icons.js";
import { GITHUB_URL, LINKEDIN_URL, PORTFOLIO_URL, CREATOR_NAME } from "../lib/creatorLinks.js";

const STACK = [
  "TypeScript",
  "React",
  "Vite",
  "Zustand",
  "WebRTC (DataChannels, ICE, STUN/TURN)",
  "Node.js + ws (signaling)",
  "Zod",
  "coturn (self-hosted TURN relay)",
  "Motion (Framer Motion)"
];

const CHALLENGES = [
  {
    title: "A multi-lane race condition that only showed up over a real network",
    body: "Running independent PeerConnections in parallel exposed a real bug: treating a DataChannel's local bufferedAmount reaching zero as proof the receiver had the data — which the WebRTC spec never promised. It worked on localhost, where round-trip time is near zero, and silently corrupted transfers once real latency was involved. The fix was a receiver-confirmed completion handshake, verified with a regression test that fails without the fix and passes with it."
  },
  {
    title: "TURN relay port exhaustion under concurrent load",
    body: "A self-hosted coturn relay with a narrow UDP port range ran out of allocatable ports under multiple simultaneous independent connections — found by reading the relay's own logs during a real multi-device test, not by guessing. Widened the range from 41 to 6,000 ports and re-verified with live CPU/network monitoring on the relay during an actual transfer."
  },
  {
    title: "Direct peer-to-peer fails more often than it should on real networks",
    body: "Institutional Wi-Fi, campus guest networks, and cellular connections routinely block direct WebRTC connectivity through client isolation or firewall policy — confirmed directly across several real physical-device tests on different networks this project. TURN relay fallback isn't an edge case; for a meaningful fraction of real users, it's the only path that works at all."
  }
];

export function CreatorPage() {
  return (
    <div className="container container-wide creator-page">
      <Reveal>
        <div className="eyebrow">Creator</div>
      </Reveal>
      <Reveal delay={60}>
        <h1 className="hero-title" style={{ fontSize: "clamp(2rem, 3vw + 1rem, 2.75rem)" }}>
          Built by {CREATOR_NAME}
        </h1>
      </Reveal>
      <Reveal delay={120}>
        <p className="hero-sub">
          Computer Science student at San José State University. I build systems where the interesting part is
          underneath the surface — network transport, real-time data movement, and the gap between how a protocol
          is supposed to behave and how it actually behaves on a real network.
        </p>
      </Reveal>

      <Reveal delay={160}>
        <div className="creator-links">
          <a className="btn btn-secondary" href={GITHUB_URL} target="_blank" rel="noreferrer">
            <IconGithub width={16} height={16} /> GitHub
          </a>
          <a className="btn btn-secondary" href={LINKEDIN_URL} target="_blank" rel="noreferrer">
            LinkedIn
          </a>
          {PORTFOLIO_URL ? (
            <a className="btn btn-secondary" href={PORTFOLIO_URL} target="_blank" rel="noreferrer">
              Portfolio
            </a>
          ) : null}
        </div>
      </Reveal>

      <section className="section">
        <Reveal>
          <div className="eyebrow">Why FD9 exists</div>
        </Reveal>
        <Reveal delay={60}>
          <p className="register-body">
            Most "send a file" tools quietly upload your file to a server first, then make the other person download
            it from that same server. FD9 exists to prove that step is unnecessary for most transfers — two browsers
            can negotiate a direct connection and move bytes straight between them, falling back to a relay only when
            the network genuinely requires it. Building it meant confronting WebRTC's real behavior directly: what
            the spec promises, what browsers actually do, and what real NAT/firewall topologies actually allow.
          </p>
        </Reveal>
      </section>

      <section className="section">
        <Reveal>
          <div className="eyebrow">Technology</div>
        </Reveal>
        <Reveal delay={60}>
          <div className="creator-stack">
            {STACK.map((s) => (
              <span key={s} className="creator-stack-pill">
                {s}
              </span>
            ))}
          </div>
        </Reveal>
      </section>

      <section className="section">
        <Reveal>
          <h2 className="eyebrow">Engineering challenges</h2>
        </Reveal>
        <div className="steps" style={{ marginTop: "var(--space-5)" }}>
          {CHALLENGES.map((c, i) => (
            <Reveal key={c.title} delay={i * 80} className="step" direction={i % 2 ? "right" : "left"}>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section">
        <Reveal>
          <div className="eyebrow">What I learned</div>
        </Reveal>
        <Reveal delay={60}>
          <p className="register-body">
            The gap between "it works on my machine" and "it works on a real network" is where almost all of the
            real engineering lives. A loopback test on one laptop will hide exactly the race conditions and timing
            assumptions that break on a genuinely independent, higher-latency connection — the fix isn't to test
            more on localhost, it's to get real physical devices on real, different networks as early as possible
            and let the evidence — not intuition — decide what's actually wrong.
          </p>
        </Reveal>
      </section>
    </div>
  );
}
