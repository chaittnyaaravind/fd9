const NODES: { x: number; y: number; r: number }[] = [
  { x: 20, y: 60, r: 5 },
  { x: 60, y: 24, r: 3.5 },
  { x: 60, y: 60, r: 4 },
  { x: 60, y: 96, r: 3.5 },
  { x: 104, y: 14, r: 3 },
  { x: 104, y: 40, r: 3 },
  { x: 104, y: 76, r: 3 },
  { x: 104, y: 104, r: 3 }
];

const EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 4],
  [1, 5],
  [2, 5],
  [2, 6],
  [3, 6],
  [3, 7]
];

/** A branching career-paths graph — one starting point fanning into several possible routes, softly pulsing to suggest exploration rather than a fixed outcome. */
export function ProjectVisualNetwork() {
  return (
    <svg className="pv-network" viewBox="0 0 124 118" aria-hidden="true">
      {EDGES.map(([a, b], i) => {
        const from = NODES[a];
        const to = NODES[b];
        return (
          <line
            key={i}
            className="pv-network-edge"
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            style={{ animationDelay: `${i * 160}ms` }}
          />
        );
      })}
      {NODES.map((n, i) => (
        <circle key={i} className="pv-network-node" cx={n.x} cy={n.y} r={n.r} style={{ animationDelay: `${i * 140}ms` }} />
      ))}
    </svg>
  );
}
