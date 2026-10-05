import { useEffect, useState } from "react";
import { motion } from "motion/react";

const DOT_COUNT = 10;

/** Fires once, briefly, the moment `fire` flips true — never retriggers on its own. */
export function SuccessBurst({ fire }: { fire: boolean }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!fire) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 900);
    return () => clearTimeout(t);
  }, [fire]);

  if (!show) return null;

  return (
    <div className="success-burst" aria-hidden="true">
      <motion.span
        className="burst-ring"
        initial={{ scale: 0.4, opacity: 0.6 }}
        animate={{ scale: 1.6, opacity: 0 }}
        transition={{ duration: 0.7, ease: [0.32, 0.72, 0, 1] }}
      />
      {Array.from({ length: DOT_COUNT }).map((_, i) => {
        const angle = (i / DOT_COUNT) * Math.PI * 2;
        const dx = Math.cos(angle) * 40;
        const dy = Math.sin(angle) * 40;
        return (
          <motion.span
            key={i}
            className={`burst-dot${i % 2 ? " is-sand" : ""}`}
            initial={{ x: 0, y: 0, opacity: 1, scale: 0.6 }}
            animate={{ x: dx, y: dy, opacity: 0, scale: 1 }}
            transition={{ duration: 0.75, ease: [0.32, 0.72, 0, 1], delay: i * 0.015 }}
          />
        );
      })}
    </div>
  );
}
