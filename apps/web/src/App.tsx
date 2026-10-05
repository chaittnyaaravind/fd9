import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HomePage } from "./pages/Home.js";
import { SendPage } from "./pages/Send.js";
import { ReceivePage } from "./pages/Receive.js";
import { useSessionStore } from "./state/session.js";

type View = "home" | "send" | "receive";

const swipeVariants = {
  enter: (direction: number) => ({ x: direction > 0 ? 48 : -48, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction > 0 ? -48 : 48, opacity: 0 })
};

export function App() {
  const [view, setView] = useState<View>("home");
  const [direction, setDirection] = useState(1);
  const [joinRoomId, setJoinRoomId] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const reset = useSessionStore((s) => s.reset);
  const reduceMotion = useReducedMotion();
  const viewDepth = useRef<Record<View, number>>({ home: 0, send: 1, receive: 1 });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room");
    if (room) {
      setJoinRoomId(room);
      setView("receive");
    }
  }, []);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 24);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function navigate(next: View) {
    setDirection(viewDepth.current[next] >= viewDepth.current[view] ? 1 : -1);
    window.scrollTo({ top: 0 });
    setView(next);
  }

  function goHome() {
    reset();
    setJoinRoomId(null);
    window.history.replaceState(null, "", window.location.pathname);
    navigate("home");
  }

  return (
    <div className="app-shell">
      <header className={`topbar${scrolled ? " is-scrolled" : ""}`}>
        <button className="wordmark" onClick={goHome} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
          Fd9<small>wherever → whomever</small>
        </button>
      </header>
      <main className="main">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={view}
            custom={direction}
            variants={reduceMotion ? undefined : swipeVariants}
            initial={reduceMotion ? { opacity: 0 } : "enter"}
            animate={reduceMotion ? { opacity: 1 } : "center"}
            exit={reduceMotion ? { opacity: 0 } : "exit"}
            transition={{ duration: reduceMotion ? 0.15 : 0.38, ease: [0.35, 0, 0, 1] }}
          >
            {view === "home" ? (
              <HomePage onSend={() => navigate("send")} onReceive={() => navigate("receive")} />
            ) : view === "send" ? (
              <SendPage onExit={goHome} />
            ) : (
              <ReceivePage initialRoomId={joinRoomId} onExit={goHome} />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
