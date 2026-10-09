import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

const LazyCreatorHeroScene = lazy(() => import("./three/CreatorHeroScene.js"));

/**
 * The Creator page's single "hard idea" hero object — see HeroCanvas.tsx
 * (Home page) for the pattern this follows: its own lazy chunk, paused via
 * IntersectionObserver when scrolled offscreen, no parallax on coarse
 * pointers, and no JS chunk requested at all under reduced-motion (the CSS
 * radial-gradient backdrop in .creator-hero::before is the fallback).
 */
export function CreatorHeroCanvas() {
  const reduceMotion = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const [visible, setVisible] = useState(true);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 700);
  const [coarsePointer] = useState(() => window.matchMedia("(pointer: coarse)").matches);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.05
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function onResize() {
      setNarrow(window.innerWidth < 700);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (coarsePointer) return;
    function onMove(e: PointerEvent) {
      mouseRef.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouseRef.current.y = (e.clientY / window.innerHeight) * 2 - 1;
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [coarsePointer]);

  if (reduceMotion) return null;

  return (
    <div className="creator-hero-canvas-wrap" ref={wrapRef} aria-hidden="true">
      <Suspense fallback={null}>
        <LazyCreatorHeroScene
          particleCount={narrow ? 90 : 220}
          parallax={!coarsePointer}
          paused={!visible}
          mouseRef={mouseRef}
        />
      </Suspense>
    </div>
  );
}
