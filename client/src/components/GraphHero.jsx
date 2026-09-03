import { useEffect, useRef } from "react";

// Nodes represent a small movie-graph fragment: a director connected to
// films, films connected to shared actors/genres — traversal lights up
// in sequence, echoing how a graph query actually walks the data.
const nodes = [
  { id: "d1", x: 60, y: 140, r: 7, label: "Director", color: "#C9A24B" },
  { id: "m1", x: 190, y: 70, r: 9, label: "Film", color: "#F2F0EC" },
  { id: "m2", x: 190, y: 150, r: 9, label: "Film", color: "#F2F0EC" },
  { id: "m3", x: 190, y: 230, r: 9, label: "Film", color: "#F2F0EC" },
  { id: "a1", x: 330, y: 40, r: 6, label: "Actor", color: "#4FB8A8" },
  { id: "a2", x: 330, y: 110, r: 6, label: "Actor", color: "#4FB8A8" },
  { id: "g1", x: 330, y: 190, r: 6, label: "Genre", color: "#4FB8A8" },
  { id: "a3", x: 330, y: 260, r: 6, label: "Actor", color: "#4FB8A8" },
];

const edges = [
  ["d1", "m1"], ["d1", "m2"], ["d1", "m3"],
  ["m1", "a1"], ["m1", "a2"],
  ["m2", "a2"], ["m2", "g1"],
  ["m3", "g1"], ["m3", "a3"],
];

export default function GraphHero() {
  const pathRefs = useRef([]);

  useEffect(() => {
    // Single orchestrated reveal on mount — edges draw in sequence,
    // nodes pulse as the "traversal" reaches them. No looping/idle motion.
    pathRefs.current.forEach((el, i) => {
      if (!el) return;
      const len = el.getTotalLength();
      el.style.strokeDasharray = `${len}`;
      el.style.strokeDashoffset = `${len}`;
      el.getBoundingClientRect(); // force reflow
      el.style.transition = `stroke-dashoffset 0.7s ease-out ${0.15 + i * 0.12}s`;
      el.style.strokeDashoffset = "0";
    });
  }, []);

  return (
    <svg viewBox="0 0 390 300" className="h-full w-full" aria-hidden="true">
      {edges.map(([from, to], i) => {
        const a = nodes.find((n) => n.id === from);
        const b = nodes.find((n) => n.id === to);
        return (
          <path
            key={i}
            ref={(el) => (pathRefs.current[i] = el)}
            d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`}
            stroke="#3A3740"
            strokeWidth="1.4"
            fill="none"
          />
        );
      })}
      {nodes.map((n, i) => (
        <g
          key={n.id}
          style={{
            opacity: 0,
            transformBox: "fill-box",
            transformOrigin: "center",
            animation: `nodeIn 0.4s ease-out ${0.5 + i * 0.15}s forwards`,
          }}
        >
          <circle cx={n.x} cy={n.y} r={n.r} fill={n.color} />
          <circle cx={n.x} cy={n.y} r={n.r + 5} fill="none" stroke={n.color} strokeWidth="1" opacity="0.35" />
        </g>
      ))}
      <style>{`
        @keyframes nodeIn {
          from { opacity: 0; transform: scale(0.4); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </svg>
  );
}
