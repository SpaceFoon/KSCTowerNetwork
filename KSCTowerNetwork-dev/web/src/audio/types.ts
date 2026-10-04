/**
 * Send-path Kerbalizer parameters (outgoing mic before WebRTC publish).
 * All values are clamped by the implementation when applied.
 */
export type KerbalizerParams = {
  /** When false, output is unprocessed mic (full bypass; same MediaStream graph may still run). */
  enabled: boolean;
  /** Effect intensity: EQ emphasis, band-limit, and saturation drive (0–1). */
  strength: number;
  /** Wet/dry mix: 0 = dry only, 1 = full wet (0–1). */
  wet: number;
  /** Optional "Kerbal" nasal/formant emphasis (0–1). */
  character: number;
  /**
   * Full Kerbal voice mode: pitch-shifts the post-EQ/saturation signal upward by `pitchSemitones`
   * using a granular (two-tap Hann-windowed) shifter, giving speech that "chipmunky Kerbalese"
   * character. Worklet path only; fallback ignores.
   */
  kerbalVoice: boolean;
  /**
   * Upward pitch shift in semitones applied when `kerbalVoice` is true. 0 = no shift, 12 = +1 octave.
   * ~5–7 st is the classic Kerbal range. Worklet path only.
   */
  pitchSemitones: number;
};

export const DEFAULT_KERBALIZER_PARAMS: KerbalizerParams = {
  enabled: true,
  strength: 0.55,
  wet: 0.85,
  character: 0.55,
  kerbalVoice: false,
  pitchSemitones: 6
};

export type KerbalizerMode = "worklet" | "fallback";

export type KerbalizerMeters = {
  /** RMS level of the input tap (0–1, loosely normalized for UI meters). */
  input: number;
  /** RMS level after processing (0–1). */
  output: number;
};

export type KerbalizerHandle = {
  /** Processed track to pass to LiveKit `createLocalAudioTrack` / `publishTrack`. */
  outputTrack: MediaStreamTrack;
  /** Original mic track supplied at creation. */
  inputTrack: MediaStreamTrack;
  mode: KerbalizerMode;
  setParams: (partial: Partial<KerbalizerParams>) => void;
  getParams: () => KerbalizerParams;
  /** Latest meter snapshot (updated by the metering loop). */
  getMeters: () => KerbalizerMeters;
  /** Subscribe to meter updates (~30 Hz). Returns unsubscribe. */
  subscribeMeters: (fn: (m: KerbalizerMeters) => void) => () => void;
  dispose: () => void;
};
