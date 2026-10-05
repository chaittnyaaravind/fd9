import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";

interface Props {
  quote: string;
  attribution?: string;
}

/** Big centered statement that fades/lifts in as it scrolls through the viewport — classic scroll-linked (not just on/off) reveal. */
export function QuoteSection({ quote, attribution }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 85%", "start 35%"] });
  const opacity = useTransform(scrollYProgress, [0, 1], [0.15, 1]);
  const y = useTransform(scrollYProgress, [0, 1], [24, 0]);

  return (
    <section className="section quote-section" ref={ref}>
      <div className="container container-wide">
        <motion.p className="quote-text" style={{ opacity, y }}>
          {quote}
        </motion.p>
        {attribution ? <div className="quote-attribution">{attribution}</div> : null}
      </div>
    </section>
  );
}
