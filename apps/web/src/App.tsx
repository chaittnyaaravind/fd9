import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HomePage } from "./pages/Home.js";
import { SendPage } from "./pages/Send.js";
import { ReceivePage } from "./pages/Receive.js";
import { HowItWorksPage } from "./pages/HowItWorks.js";
import { PerformancePage } from "./pages/Performance.js";
import { CreatorPage } from "./pages/Creator.js";
import { Nav, type RoutePath } from "./components/Nav.js";
import { Footer } from "./components/Footer.js";
import { useSessionStore } from "./state/session.js";

const VIEW_DEPTH: Record<RoutePath, number> = {
  "/": 0,
  "/how-it-works": 1,
  "/performance": 1,
  "/creator": 1,
  "/send": 1,
  "/receive": 1
};

const KNOWN_PATHS = new Set<RoutePath>(["/", "/send", "/receive", "/how-it-works", "/performance", "/creator"]);

function resolvePath(pathname: string): RoutePath {
  return KNOWN_PATHS.has(pathname as RoutePath) ? (pathname as RoutePath) : "/";
}

const swipeVariants = {
  enter: (direction: number) => ({ x: direction > 0 ? 48 : -48, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction > 0 ? -48 : 48, opacity: 0 })
};

export function App() {
  const [path, setPath] = useState<RoutePath>(() => resolvePath(window.location.pathname));
  const [direction, setDirection] = useState(1);
  const [joinRoomId, setJoinRoomId] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const reset = useSessionStore((s) => s.reset);
  const reduceMotion = useReducedMotion();
  const pathRef = useRef(path);
  pathRef.current = path;

  function navigate(next: RoutePath, opts?: { replace?: boolean; fromPopState?: boolean }) {
    setDirection(VIEW_DEPTH[next] >= VIEW_DEPTH[pathRef.current] ? 1 : -1);
    window.scrollTo({ top: 0 });
    if (!opts?.fromPopState) {
      if (opts?.replace) window.history.replaceState(null, "", next);
      else window.history.pushState(null, "", next);
    }
    setPath(next);
  }

  // `?room=<id>` is a deep-link shortcut (e.g. from a QR code) straight into
  // the receive flow — kept as a query param (not folded into the path
  // scheme) since it carries a per-session value, not a page identity.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room");
    if (room) {
      setJoinRoomId(room);
      navigate("/receive", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onPopState() {
      navigate(resolvePath(window.location.pathname), { fromPopState: true });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 24);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function goHome() {
    reset();
    setJoinRoomId(null);
    navigate("/");
  }

  return (
    <div className="app-shell">
      <Nav scrolled={scrolled} current={path} onNavigate={navigate} />
      <main className="main">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={path}
            custom={direction}
            variants={reduceMotion ? undefined : swipeVariants}
            initial={reduceMotion ? { opacity: 0 } : "enter"}
            animate={reduceMotion ? { opacity: 1 } : "center"}
            exit={reduceMotion ? { opacity: 0 } : "exit"}
            transition={{ duration: reduceMotion ? 0.15 : 0.38, ease: [0.35, 0, 0, 1] }}
          >
            {path === "/" ? (
              <HomePage onSend={() => navigate("/send")} onReceive={() => navigate("/receive")} />
            ) : path === "/send" ? (
              <SendPage onExit={goHome} />
            ) : path === "/receive" ? (
              <ReceivePage initialRoomId={joinRoomId} onExit={goHome} />
            ) : path === "/how-it-works" ? (
              <HowItWorksPage />
            ) : path === "/performance" ? (
              <PerformancePage />
            ) : (
              <CreatorPage />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
      <Footer onNavigate={navigate} />
    </div>
  );
}
