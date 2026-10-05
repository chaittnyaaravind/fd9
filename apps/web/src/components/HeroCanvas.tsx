import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

const LazyHeroScene = lazy(() => import("./three/HeroScene.js"));

/**
 * Ambient 3D backdrop for the hero — a sparse, slowly-drifting particle
 * field standing in for "devices on a network." Deliberately restrained:
 * no bloom/postprocessing, no literal device models (TransferVisual
 * already owns that job), just depth and motion behind the real content.
 *
 * Reduced-motion users get nothing here at all — not even the JS chunk is
 * requested — and fall back to the existing CSS radial-gradient backdrop
 * in .hero-section::before, which is the "lightweight fallback."
 */
export function HeroCanvas() {
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
    <div className="hero-canvas-wrap" ref={wrapRef} aria-hidden="true">
      <Suspense fallback={null}>
        <LazyHeroScene
          particleCount={narrow ? 70 : 170}
          parallax={!coarsePointer}
          paused={!visible}
          mouseRef={mouseRef}
        />
      </Suspense>
    </div>
  );
}
