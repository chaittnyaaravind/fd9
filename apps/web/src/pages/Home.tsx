import { useRef } from "react";
import type { MouseEvent, ReactNode } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { Reveal } from "../components/Reveal.js";
import { TransferVisual } from "../components/TransferVisual.js";
import { HeroCanvas } from "../components/HeroCanvas.js";
import { QuoteSection } from "../components/QuoteSection.js";
import { IconDownload, IconUpload } from "../components/icons.js";

interface Props {
  onSend: () => void;
  onReceive: () => void;
}

const STEPS = [
  {
    n: "01",
    title: "Pair instantly",
    body: "One device opens a room and shows a QR code and a short code. The other scans or types it — no accounts, no app install."
  },
  {
    n: "02",
    title: "Connect directly",
    body: "Browsers negotiate a WebRTC link straight to each other. Our server only ever helps two browsers find each other — it never sees your files."
  },
  {
    n: "03",
    title: "Move at full speed",
    body: "Chunk size is sized to what this exact connection actually supports, with deep pipelining and backpressure — tuned to go as fast as your network and browser allow."
  }
];

const FEATURES = [
  { title: "Any file, untouched", body: "No conversion, no re-encoding, no arbitrary size cap from Fd9 itself." },
  { title: "Byte-verified", body: "An incremental SHA-256 runs on both ends. If one bit is wrong, you're told — not left guessing." },
  { title: "Pause, resume, cancel", body: "Control a transfer mid-flight from either side, without losing what's already landed." },
  { title: "Visible, not hidden", body: "You always see direct vs. relayed, queued vs. confirmed — never a spinner hiding what's really happening." },
  { title: "Streams to disk", body: "Large files write straight to storage in Chrome and Edge instead of filling up memory." },
  { title: "Nothing lingers", body: "Rooms are random, temporary, and gone the moment a session ends or goes unused." }
];

const SPRING = { type: "spring", stiffness: 420, damping: 34 } as const;

function SpotlightCard({
  onClick,
  icon,
  title,
  body,
  variant = "blue"
}: {
  onClick: () => void;
  icon: ReactNode;
  title: string;
  body: string;
  variant?: "blue" | "sand";
}) {
  function handleMove(e: MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const style = e.currentTarget.style;
    style.setProperty("--mx", `${e.clientX - rect.left}px`);
    style.setProperty("--my", `${e.clientY - rect.top}px`);
  }

  return (
    <motion.button
      className="entry-card"
      onClick={onClick}
      onMouseMove={handleMove}
      whileHover={{ y: -4, borderColor: "var(--hairline-strong)" }}
      whileTap={{ scale: 0.98 }}
      transition={SPRING}
    >
      <span className={`icon${variant === "sand" ? " icon-sand" : ""}`} aria-hidden="true">
        {icon}
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </motion.button>
  );
}

function Hero() {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const opacity = useTransform(scrollYProgress, [0, 1], [1, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [1, 0.94]);
  const y = useTransform(scrollYProgress, [0, 1], [0, -40]);

  return (
    <section className="hero-section" ref={ref}>
      <HeroCanvas />
      <motion.div
        className="container"
        style={{
          position: "relative",
          zIndex: 1,
          ...(reduceMotion ? undefined : { opacity, scale, y })
        }}
      >
        <Reveal>
          <div className="eyebrow">Device to device</div>
        </Reveal>
        <Reveal delay={60}>
          <h1 className="hero-title">Send files, wherever to whomever.</h1>
        </Reveal>
        <Reveal delay={120}>
          <p className="hero-sub">
            Pair two browsers with a QR code or a short code, then transfer directly between them — no upload to a
            server in between.
          </p>
        </Reveal>
        <Reveal delay={160}>
          <div className="stat-line">SHA-256 verified · WebRTC peer-to-peer · 4–256 KiB adaptive chunks</div>
        </Reveal>
        <Reveal delay={200}>
          <TransferVisual />
        </Reveal>
      </motion.div>
      <div className="scroll-cue" aria-hidden="true">
        <span />
      </div>
    </section>
  );
}

export function HomePage({ onSend, onReceive }: Props) {
  return (
    <>
      <Hero />

      <section className="section">
        <div className="container">
          <Reveal>
            <h2 className="eyebrow">How it works</h2>
          </Reveal>
          <div className="steps">
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 90} className="step" direction={i % 2 ? "right" : "left"}>
                <div className="step-n">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-register">
        <div className="container">
          <Reveal>
            <div className="eyebrow">Why Fd9</div>
          </Reveal>
          <Reveal delay={60}>
            <h2 className="register-title">Your files are yours. Even in transit.</h2>
          </Reveal>
          <Reveal delay={120}>
            <p className="register-body">
              Most "share a file" tools quietly upload your file to a server first. Fd9 doesn't — the signaling
              server only helps two browsers describe a connection to each other (think: an introduction, not a
              delivery). Once that handshake is done, bytes move directly between the two devices over an
              encrypted WebRTC channel. If the server disappeared the instant your transfer started, your
              transfer would keep going.
            </p>
          </Reveal>
        </div>
      </section>

      <QuoteSection quote="The fastest way to send a file is to never upload it at all." />

      <section className="section">
        <div className="container container-wide">
          <Reveal>
            <div className="eyebrow">What it can do</div>
          </Reveal>
          <div className="feature-grid">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={i * 70} className="feature-card" direction={i % 2 ? "right" : "left"}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section cta-section">
        <div className="container">
          <Reveal>
            <div className="eyebrow">Ready when you are</div>
          </Reveal>
          <Reveal delay={60}>
            <h2 className="register-title" style={{ marginBottom: "var(--space-6)" }}>
              Start a transfer
            </h2>
          </Reveal>
          <Reveal delay={120}>
            <div className="entry-grid">
              <SpotlightCard
                onClick={onSend}
                icon={<IconUpload />}
                title="Send files"
                body="Pick files, share a code, and start sending the moment the other device joins."
              />
              <SpotlightCard
                onClick={onReceive}
                icon={<IconDownload />}
                variant="sand"
                title="Receive files"
                body="Enter a code or scan a QR code to connect and approve what comes in."
              />
            </div>
          </Reveal>
          <p className="footnote">
            Works in modern Chrome, Edge, Firefox, and Safari. Large transfers stream straight to disk in
            Chrome/Edge; other browsers hold the file in memory up to a few hundred MB.
          </p>
        </div>
      </section>
    </>
  );
}
