import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import { IconDownload, IconUpload } from "./icons.js";

const LABELS = ["Direct connection", "End-to-end encrypted", "Byte-verified"];

/** Purely illustrative — the mechanism, not a fabricated speed number. */
export function TransferVisual() {
  const [labelIndex, setLabelIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useSpring(useTransform(my, [-40, 40], [6, -6]), { stiffness: 150, damping: 20 });
  const rotateY = useSpring(useTransform(mx, [-200, 200], [-6, 6]), { stiffness: 150, damping: 20 });

  useEffect(() => {
    const id = setInterval(() => setLabelIndex((i) => (i + 1) % LABELS.length), 2200);
    return () => clearInterval(id);
  }, []);

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    if (reduceMotion || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    mx.set(e.clientX - rect.left - rect.width / 2);
    my.set(e.clientY - rect.top - rect.height / 2);
  }

  function handleLeave() {
    mx.set(0);
    my.set(0);
  }

  return (
    <motion.div
      ref={ref}
      className="transfer-visual"
      aria-hidden="true"
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      style={reduceMotion ? undefined : { rotateX, rotateY, transformPerspective: 600 }}
    >
      <div className="tv-device tv-device-a">
        <IconUpload width={22} height={22} />
      </div>
      <div className="tv-link">
        <span className="tv-packet p1" />
        <span className="tv-packet p2" />
        <span className="tv-packet p3" />
      </div>
      <div className="tv-device tv-device-b">
        <IconDownload width={22} height={22} />
      </div>
      <div className="tv-label-wrap">
        <AnimatePresence mode="wait">
          <motion.div
            key={labelIndex}
            className="tv-label"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.35 }}
          >
            {LABELS[labelIndex]}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
