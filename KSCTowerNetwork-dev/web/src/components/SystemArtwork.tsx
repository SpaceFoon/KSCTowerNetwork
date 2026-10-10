import { useId } from "react";
import type { SystemCatalogBody } from "../data/systemCatalog";

// Fixed seed keeps the sky stable across telemetry updates and multiple wall panels.
const stars = Array.from({ length: 640 }, (_, i) => {
  const noise = (n: number) => {
    const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  return { x: noise(i + 1) * 1600, y: noise(i + 900) * 1000,
    r: 0.35 + noise(i + 1800) ** 5 * 1.5, opacity: 0.2 + noise(i + 2700) * 0.65 };
});

export function SystemSky() {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="system-schematic-sky" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-dust`}>
          <stop stopColor="#8094b1" stopOpacity="0.12" />
          <stop offset="0.5" stopColor="#485672" stopOpacity="0.06" />
          <stop offset="1" stopColor="#030711" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-spark`}>
          <stop stopColor="#e2eeff" stopOpacity="0.6" />
          <stop offset="0.15" stopColor="#adcfff" stopOpacity="0.2" />
          <stop offset="1" stopColor="#adcfff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1600" height="1000" fill="#030711" />
      <g transform="rotate(-28 800 500)">
        {[0, 1, 2, 3, 4].map(i => <ellipse key={i} cx={200 + i * 310} cy={440 + Math.sin(i) * 70} rx="420" ry="130" fill={`url(#${id}-dust)`} />)}
      </g>
      {stars.map((s, i) => <circle key={i} cx={s.x} cy={s.y} r={s.r} opacity={s.opacity} fill={i % 7 === 0 ? "#f5d6b0" : i % 3 === 0 ? "#a9c9ed" : "#e1e9f4"} />)}
      {stars.filter(s => s.r > 1.65).map((s, i) => <circle key={i} cx={s.x} cy={s.y} r="9" fill={`url(#${id}-spark)`} />)}
    </svg>
  );
}

type Appearance = { base: string; surface: string; kind: "ocean" | "gas" | "rock"; rings?: boolean };
const appearances: Record<string, Appearance> = {
  kerbin: { base: "#276ea3", surface: "#86a77a", kind: "ocean" },
  earth: { base: "#24679b", surface: "#8b9f72", kind: "ocean" },
  laythe: { base: "#316d93", surface: "#b2ac82", kind: "ocean" },
  eve: { base: "#694496", surface: "#bfa1ce", kind: "ocean" },
  duna: { base: "#bd6845", surface: "#eaa77d", kind: "rock" },
  mars: { base: "#b76947", surface: "#e3a380", kind: "rock" },
  jool: { base: "#71a54d", surface: "#c7dd8a", kind: "gas" },
  jupiter: { base: "#ad8064", surface: "#e9d6ad", kind: "gas" },
  sarnus: { base: "#b88e74", surface: "#ecd2a4", kind: "gas", rings: true },
  saturn: { base: "#b79f72", surface: "#f0dfb0", kind: "gas", rings: true },
  urlum: { base: "#71b3bc", surface: "#c4e7df", kind: "gas", rings: true },
  uranus: { base: "#76b9c8", surface: "#c2e7e5", kind: "gas", rings: true },
  neidon: { base: "#6c72b2", surface: "#b0ace6", kind: "gas" },
  neptune: { base: "#3e70be", surface: "#83b5e0", kind: "gas" },
  minmus: { base: "#83aaa0", surface: "#d2e6ce", kind: "rock" },
  moho: { base: "#867665", surface: "#beaa90", kind: "rock" },
  venus: { base: "#b49a6b", surface: "#eee0b6", kind: "gas" },
};

/** Illustrated identity cues, not geographic maps or live lighting/rotation. */
export function planetAccentFor(body: SystemCatalogBody): string {
  return body.isStar ? "#ffbf64" : appearances[body.name.toLowerCase()]?.base ?? "#8e929b";
}

export function planetAppearanceFor(body: SystemCatalogBody): Appearance {
  return appearances[body.name.toLowerCase()] ?? { base: "#8e929b", surface: "#c4c5c9", kind: "rock" };
}

export function PlanetArtwork({ body, radius, lightAngle = -135, textureUrl }: {
  body: SystemCatalogBody; radius: number; lightAngle?: number; textureUrl?: string;
}) {
  const id = useId().replace(/:/g, "");
  const look = appearances[body.name.toLowerCase()] ?? {
    base: "#8e929b", surface: "#c4c5c9", kind: "rock"
  };
  const ring = (front: boolean) => <path
    d={front ? "M -31 0 A 31 10 0 0 0 31 0" : "M -31 0 A 31 10 0 0 1 31 0"}
    transform="rotate(-24)" fill="none" stroke={look.surface} strokeWidth="5" strokeOpacity="0.58"
  />;
  return (
    <g transform={`scale(${radius / 20})`} pointerEvents="none">
      <defs>
        <clipPath id={`${id}-disc`}><circle r="20" /></clipPath>
        <radialGradient id={`${id}-limb`} cx="42%" cy="38%" r="65%">
          <stop stopColor="#ffffff" stopOpacity="0.1" />
          <stop offset="0.6" stopColor="#02050c" stopOpacity="0" />
          <stop offset="1" stopColor="#02050c" stopOpacity="0.65" />
        </radialGradient>
        <linearGradient id={`${id}-night`} x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#02050c" stopOpacity="0.88" />
          <stop offset="0.44" stopColor="#02050c" stopOpacity="0.6" />
          <stop offset="0.7" stopColor="#02050c" stopOpacity="0.06" />
          <stop offset="1" stopColor="#fff2d0" stopOpacity="0.15" />
        </linearGradient>
        <radialGradient id={`${id}-air`}>
          <stop offset="0.72" stopColor="#9fcfff" stopOpacity="0" />
          <stop offset="0.84" stopColor="#9fcfff" stopOpacity="0.23" />
          <stop offset="1" stopColor="#9fcfff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {look.rings && ring(false)}
      {body.hasAtmosphere && <circle r="25" fill={`url(#${id}-air)`} />}
      <circle r="20" fill={look.base} />
      <g clipPath={`url(#${id}-disc)`}>
        <g>
        {look.kind === "ocean" ? <>
          <g fill={look.surface}>
            <path d="M-23-11L-13-16-8-13-10-7-4-4-6 1-12 3-15 9-21 4ZM-3-19L5-17 7-11 13-9 10-3 15 1 9 4 7 13 2 16-2 10 0 4-5-1-1-8Z" />
            <path d="M13 9L20 6 24 12 17 18 11 16Z" />
          </g>
          <g fill="none" stroke="#f4f4ec" strokeOpacity="0.5" strokeWidth="1.7">
            <path d="M-24-6Q-14-12-4-7T22-9M-19 8Q-9 1 1 7T23 5M-5-16Q7-13 17-16" />
          </g>
          <path d="M-17-16Q0-22 17-16L10-19H-10ZM-13 17Q0 13 13 17L7 21H-7Z" fill="#eef3f2" opacity="0.8" />
        </> : look.kind === "gas" ? <g transform="rotate(-12)" fill="none" stroke={look.surface}>
          {[-17, -12, -5, 2, 7, 14, 19].map((y, i) => <path key={y} d={`M-24 ${y} Q-8 ${y + 4} 4 ${y + 1} T24 ${y}`} strokeWidth={i % 2 === 0 ? 3.2 : 1.4} opacity={i % 2 === 0 ? 0.6 : 0.35} />)}
          <ellipse cx="8" cy="7" rx="5" ry="2.2" fill={look.base} strokeWidth="1" opacity="0.7" />
        </g> : <g fill={look.surface}>
          <path d="M-23-9Q-12-17-2-10T22-12L24-3Q11 5 2-1T-23 4ZM-20 15Q-7 5 3 12T24 9L22 23H-20Z" opacity="0.3" />
          {[[-10, -5, 4], [5, -11, 2.8], [9, 6, 5], [-5, 12, 2.5], [-15, 7, 2], [1, 0, 1.5]].map(([x, y, r], i) => <g key={i}>
            <circle cx={x} cy={y} r={r} fill="#22232d" opacity="0.3" />
            <circle cx={x! + 0.6} cy={y! + 0.7} r={r! * 0.78} opacity="0.3" />
          </g>)}
        </g>}
        </g>
        {textureUrl && <image href={textureUrl} x="-24" y="-20" width="80" height="40" preserveAspectRatio="none" />}
        <circle r="20" fill={`url(#${id}-limb)`} />
        <circle r="20" fill={`url(#${id}-night)`} transform={`rotate(${lightAngle})`} />
      </g>
      <circle r="20" fill="none" stroke={look.surface} strokeOpacity="0.28" strokeWidth="0.5" />
      {look.rings && ring(true)}
    </g>
  );
}
