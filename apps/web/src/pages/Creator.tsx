import type { ReactNode } from "react";
import { Reveal } from "../components/Reveal.js";
import { CreatorHeroCanvas } from "../components/CreatorHeroCanvas.js";
import { ProjectCard } from "../components/creator/ProjectCard.js";
import { ProjectVisualFD9 } from "../components/creator/ProjectVisualFD9.js";
import { ProjectVisualWaveform } from "../components/creator/ProjectVisualWaveform.js";
import { ProjectVisualNetwork } from "../components/creator/ProjectVisualNetwork.js";
import { IconGithub } from "../components/icons.js";
import { GITHUB_URL, LINKEDIN_URL, CREATOR_NAME } from "../lib/creatorLinks.js";
import { CREATOR_PROJECTS } from "../lib/creatorProjects.js";

const STACK = [
  "TypeScript",
  "React",
  "Vite",
  "Zustand",
  "WebRTC (DataChannels, ICE, STUN/TURN)",
  "Node.js + ws (signaling)",
  "Zod",
  "coturn (self-hosted TURN relay)",
  "React Three Fiber",
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

const PRINCIPLES = [
  {
    label: "Build",
    title: "Turn ideas into working software",
    body: "An idea doesn't count until it's running — a real app a second device can connect to, not a slide describing what it would do."
  },
  {
    label: "Explore",
    title: "Learn through experiments and real-world constraints",
    body: "A loopback test on one laptop hides the failures that matter. The real behavior of a protocol, a network, or a browser only shows up once something real is pushed against it."
  },
  {
    label: "Refine",
    title: "Improve usability, performance, and reliability",
    body: "Shipping a feature is the start, not the finish — the harder, less visible work is making it honest about what it can't do yet, and fast where it's claimed to be."
  }
];

const PROJECT_VISUALS: Record<string, ReactNode> = {
  fd9: <ProjectVisualFD9 />,
  music97: <ProjectVisualWaveform />,
  "my-carrier": <ProjectVisualNetwork />
};

export function CreatorPage() {
  return (
    <div className="creator-page">
      {/* ---- Hero ---- */}
      <section className="creator-hero">
        <CreatorHeroCanvas />
        <div className="container container-wide creator-hero-content">
          <Reveal>
            <div className="eyebrow eyebrow-creator">Creator</div>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="creator-hero-title">
              I don&rsquo;t just imagine it.
              <br />I build it.
            </h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="creator-hero-sub">
              Computer science student. Independent builder. Exploring what software can become.
            </p>
          </Reveal>
          <Reveal delay={200}>
            <div className="creator-hero-ctas">
              <a className="btn btn-primary btn-creator" href="#work">
                Explore my work
              </a>
              <a className="btn btn-secondary" href="#connect">
                Connect with me
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      <div className="container container-wide">
        {/* ---- A: Introduction ---- */}
        <section className="creator-section">
          <Reveal>
            <div className="eyebrow eyebrow-creator">Introduction</div>
          </Reveal>
          <Reveal delay={60}>
            <p className="creator-register-body">
              I'm {CREATOR_NAME}, a Computer Science student at San José State University. I build systems where
              the interesting part is underneath the surface — network transport, real-time data movement, and
              the gap between how a protocol is supposed to behave and how it actually behaves on a real network.
            </p>
          </Reveal>
        </section>

        {/* ---- B: Selected projects ---- */}
        <section className="creator-section" id="work">
          <Reveal>
            <div className="eyebrow eyebrow-creator">Selected projects</div>
          </Reveal>
          <Reveal delay={60}>
            <h2 className="creator-register-title">What I've actually shipped</h2>
          </Reveal>
          <div className="project-grid">
            {CREATOR_PROJECTS.map((project, i) => (
              <Reveal key={project.id} delay={i * 90} direction={i % 2 ? "right" : "left"}>
                <ProjectCard project={project} visual={PROJECT_VISUALS[project.id]} />
              </Reveal>
            ))}
          </div>
        </section>

        {/* ---- C: How I think ---- */}
        <section className="creator-section creator-section-register">
          <Reveal>
            <div className="eyebrow eyebrow-creator">How I think</div>
          </Reveal>
          <div className="principles-grid">
            {PRINCIPLES.map((p, i) => (
              <Reveal key={p.label} delay={i * 90} className="principle-card">
                <span className="principle-label">{p.label}</span>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ---- D: Currently building (FD9 deep dive) ---- */}
        <section className="creator-section">
          <Reveal>
            <div className="eyebrow eyebrow-creator">Currently building</div>
          </Reveal>
          <Reveal delay={60}>
            <h2 className="creator-register-title">
              FD9 — <a href="https://fd9.tech" target="_blank" rel="noreferrer" className="creator-inline-link">fd9.tech</a>
            </h2>
          </Reveal>
          <Reveal delay={100}>
            <p className="creator-register-body">
              Most "send a file" tools quietly upload your file to a server first, then make the other person
              download it from that same server. FD9 exists to prove that step is unnecessary for most transfers —
              two browsers can negotiate a direct connection and move bytes straight between them, falling back to
              a relay only when the network genuinely requires it. Building it meant confronting WebRTC's real
              behavior directly: what the spec promises, what browsers actually do, and what real NAT/firewall
              topologies actually allow.
            </p>
          </Reveal>

          <Reveal delay={140}>
            <div className="eyebrow eyebrow-creator" style={{ marginTop: "var(--space-7)" }}>
              Technology
            </div>
          </Reveal>
          <Reveal delay={160}>
            <div className="creator-stack">
              {STACK.map((s) => (
                <span key={s} className="creator-stack-pill">
                  {s}
                </span>
              ))}
            </div>
          </Reveal>

          <Reveal delay={180}>
            <div className="eyebrow eyebrow-creator" style={{ marginTop: "var(--space-7)" }}>
              Engineering challenges
            </div>
          </Reveal>
          <div className="steps" style={{ marginTop: "var(--space-5)" }}>
            {CHALLENGES.map((c, i) => (
              <Reveal key={c.title} delay={i * 80} className="step" direction={i % 2 ? "right" : "left"}>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </Reveal>
            ))}
          </div>

          <Reveal delay={60}>
            <div className="eyebrow eyebrow-creator" style={{ marginTop: "var(--space-7)" }}>
              What I learned
            </div>
          </Reveal>
          <Reveal delay={80}>
            <p className="creator-register-body">
              The gap between "it works on my machine" and "it works on a real network" is where almost all of
              the real engineering lives. A loopback test on one laptop will hide exactly the race conditions and
              timing assumptions that break on a genuinely independent, higher-latency connection — the fix isn't
              to test more on localhost, it's to get real physical devices on real, different networks as early as
              possible and let the evidence — not intuition — decide what's actually wrong.
            </p>
          </Reveal>
        </section>

        {/* ---- E: About ---- */}
        <section className="creator-section creator-section-register">
          <Reveal>
            <div className="eyebrow eyebrow-creator">About</div>
          </Reveal>
          <Reveal delay={60}>
            <p className="creator-register-body">
              I'm a Computer Science student who enjoys building products, experimenting with technology, and
              turning ideas into real, working experiences — not slides or mockups. FD9 is the project I'm
              currently putting the most into, but the pattern repeats across what you see above: pick something
              real, build it honestly, and let a real network or a real user tell me what's actually wrong with it.
            </p>
          </Reveal>
        </section>

        {/* ---- F: Connect ---- */}
        <section className="creator-section creator-connect" id="connect">
          <Reveal>
            <h2 className="creator-connect-title">Have an interesting idea?</h2>
          </Reveal>
          <Reveal delay={60}>
            <p className="creator-hero-sub" style={{ margin: "0 auto var(--space-7)" }}>
              Let&rsquo;s build something worth using.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <div className="creator-links">
              <a className="btn btn-secondary" href={GITHUB_URL} target="_blank" rel="noreferrer">
                <IconGithub width={16} height={16} /> GitHub
              </a>
              <a className="btn btn-secondary" href={LINKEDIN_URL} target="_blank" rel="noreferrer">
                LinkedIn
              </a>
              <a className="btn btn-secondary" href="#work">
                Explore my projects
              </a>
            </div>
          </Reveal>
        </section>
      </div>
    </div>
  );
}
