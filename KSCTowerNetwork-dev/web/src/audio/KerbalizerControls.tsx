import type { KerbalizerMeters, KerbalizerMode, KerbalizerParams } from "./types";

type Props = {
  params: KerbalizerParams;
  onParamsChange: (next: Partial<KerbalizerParams>) => void;
  meters: KerbalizerMeters;
  mode: KerbalizerMode | null;
  disabled?: boolean;
};

function MeterBar({ label, value }: { label: string; value: number }): JSX.Element {
  const pct = Math.round(value * 100);
  return (
    <div style={{ marginBottom: "0.65rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.2rem" }}>
        <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>{label}</span>
        <span style={{ fontSize: "0.85rem" }}>{pct}%</span>
      </div>
      <div
        style={{
          height: "8px",
          borderRadius: "4px",
          background: "#0b0f14",
          border: "1px solid var(--border)",
          overflow: "hidden"
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "linear-gradient(90deg, var(--accent), var(--ok))",
            transition: "width 0.06s linear"
          }}
        />
      </div>
    </div>
  );
}

export function KerbalizerControls({ params, onParamsChange, meters, mode, disabled }: Props): JSX.Element {
  return (
    <div style={{ maxWidth: "28rem" }}>
      <p style={{ color: "var(--muted)", fontSize: "0.9rem", marginTop: 0 }}>
        Send-path Kerbalizer (outgoing mic). Use headphones if you enable local monitor elsewhere to avoid feedback.
      </p>

      <div style={{ marginBottom: "0.75rem", fontSize: "0.9rem" }}>
        DSP path:{" "}
        <strong>{mode === null ? "—" : mode === "worklet" ? "AudioWorklet" : "Main-thread fallback"}</strong>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.85rem",
          opacity: 1
        }}
      >
        <input
          type="checkbox"
          checked={params.kerbalVoice}
          disabled={disabled}
          onChange={(e) => onParamsChange({ kerbalVoice: e.target.checked })}
        />
        <span>
          <strong>Kerbal voice</strong>{" "}
          <span style={{ color: "var(--muted)", fontSize: "0.82rem" }}>
            — chipmunky pitch-shift Kerbalese (worklet path only)
          </span>
        </span>
      </label>

      {params.kerbalVoice ? (
        <div style={{ marginBottom: "0.85rem", opacity: 1 }}>
          <label
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "0.35rem",
              color: "var(--muted)",
              fontSize: "0.85rem"
            }}
          >
            <span>Pitch (semitones up)</span>
            <span>+{params.pitchSemitones.toFixed(1)} st</span>
          </label>
          <input
            type="range"
            min={0}
            max={12}
            step={0.5}
            value={params.pitchSemitones}
            disabled={disabled}
            onChange={(e) => onParamsChange({ pitchSemitones: Number(e.target.value) })}
            style={{ width: "100%" }}
          />
          <div style={{ color: "var(--muted)", fontSize: "0.78rem", marginTop: "0.2rem" }}>
            Classic Kerbal range is ~5–7 st. 0 disables the shift; 12 = +1 octave (Mickey Mouse).
          </div>
        </div>
      ) : null}

      <label style={{ display: "block", marginBottom: "0.35rem", color: "var(--muted)", fontSize: "0.85rem" }}>
        Strength (drive + band-limit)
      </label>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(params.strength * 100)}
        disabled={disabled}
        onChange={(e) => onParamsChange({ strength: Number(e.target.value) / 100 })}
        style={{ width: "100%", marginBottom: "0.75rem" }}
      />

      <label style={{ display: "block", marginBottom: "0.35rem", color: "var(--muted)", fontSize: "0.85rem" }}>
        Wet / dry mix
      </label>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(params.wet * 100)}
        disabled={disabled}
        onChange={(e) => onParamsChange({ wet: Number(e.target.value) / 100 })}
        style={{ width: "100%", marginBottom: "0.75rem" }}
      />

      <label style={{ display: "block", marginBottom: "0.35rem", color: "var(--muted)", fontSize: "0.85rem" }}>
        Character (formant emphasis)
      </label>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(params.character * 100)}
        disabled={disabled}
        onChange={(e) => onParamsChange({ character: Number(e.target.value) / 100 })}
        style={{ width: "100%", marginBottom: "1rem" }}
      />

      <MeterBar label="Input (before effect)" value={meters.input} />
      <MeterBar label="Output (send path)" value={meters.output} />
    </div>
  );
}
