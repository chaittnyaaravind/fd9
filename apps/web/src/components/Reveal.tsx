import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

type Direction = "up" | "left" | "right";

interface Props {
  children: ReactNode;
  delay?: number;
  className?: string;
  direction?: Direction;
}

const OFFSETS: Record<Direction, { x?: number; y?: number }> = {
  up: { y: 24 },
  left: { x: -32 },
  right: { x: 32 }
};

/**
 * Swipes/lifts children in (direction-dependent) once they cross into the
 * viewport, one time. useReducedMotion() short-circuits to a plain opacity
 * fade with no motion, rather than gating content behind an animation some
 * users have asked their OS to minimize.
 */
export function Reveal({ children, delay = 0, className = "", direction = "up" }: Props) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const reduceMotion = useReducedMotion();
  const offset = OFFSETS[direction];

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, ...offset, filter: "blur(4px)" }}
      animate={inView ? (reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0, y: 0, filter: "blur(0px)" }) : undefined}
      transition={{ duration: reduceMotion ? 0.2 : 0.7, delay: delay / 1000, ease: [0.32, 0.72, 0, 1] }}
    >
      {children}
    </motion.div>
  );
}
