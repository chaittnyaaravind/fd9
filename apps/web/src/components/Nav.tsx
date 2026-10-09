import { useEffect, useState } from "react";
import { motion, useReducedMotion, AnimatePresence } from "motion/react";
import { IconClose, IconGithub, IconMenu } from "./icons.js";
import { GITHUB_URL } from "../lib/creatorLinks.js";

export type RoutePath = "/" | "/send" | "/receive" | "/how-it-works" | "/performance" | "/creator";

interface Props {
  scrolled: boolean;
  current: RoutePath;
  onNavigate: (path: RoutePath) => void;
}

const LINKS: { path: RoutePath; label: string }[] = [
  { path: "/send", label: "Transfer" },
  { path: "/how-it-works", label: "How it works" },
  { path: "/performance", label: "Performance" },
  { path: "/creator", label: "Creator" }
];

export function Nav({ scrolled, current, onNavigate }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  function go(path: RoutePath) {
    setMenuOpen(false);
    onNavigate(path);
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <header className={`topbar${scrolled ? " is-scrolled" : ""}`}>
      <button className="wordmark" onClick={() => go("/")} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
        Fd9<small>wherever → whomever</small>
      </button>

      <nav className="nav-links" aria-label="Primary">
        {LINKS.map((l) => (
          <button
            key={l.path}
            className={`nav-link${current === l.path ? " is-active" : ""}`}
            onClick={() => go(l.path)}
            aria-current={current === l.path ? "page" : undefined}
          >
            {l.label}
          </button>
        ))}
      </nav>

      <div className="nav-actions">
        <a className="nav-icon-link" href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub">
          <IconGithub width={18} height={18} />
        </a>
        <button className="btn btn-primary nav-cta" onClick={() => go("/send")}>
          Send files
        </button>
        <button
          className="nav-mobile-toggle"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
        >
          {menuOpen ? <IconClose width={20} height={20} /> : <IconMenu width={20} height={20} />}
        </button>
      </div>

      <AnimatePresence>
        {menuOpen ? (
          <motion.div
            className="nav-mobile-sheet"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: reduceMotion ? 0.15 : 0.22, ease: [0.32, 0.72, 0, 1] }}
          >
            {LINKS.map((l) => (
              <button key={l.path} className={`nav-mobile-link${current === l.path ? " is-active" : ""}`} onClick={() => go(l.path)}>
                {l.label}
              </button>
            ))}
            <a className="nav-mobile-link" href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
