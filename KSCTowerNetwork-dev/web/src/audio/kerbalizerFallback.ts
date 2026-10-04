import type { KerbalizerParams } from "./types";

/** Tanh saturation curve normalized so peak amplitude stays at unity for any drive.
 *  Without normalization, increasing `drive` made the wet path noticeably louder than
 *  dry, so the wet/dry mix turned into a loudness mix rather than a character mix. */
function makeTanhCurveForDrive(drive: number, samples = 2048): Float32Array {
  const curve = new Float32Array(samples);
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) * norm;
  }
  return curve;
}

export type FallbackGraph = {
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  peak: BiquadFilterNode;
  shaper: WaveShaperNode;
  dryGain: GainNode;
  wetGain: GainNode;
  merger: GainNode;
  applyParams: (p: KerbalizerParams) => void;
};

/**
 * Main-thread DSP fallback: `input` is typically the node *after* the input level analyser
 * (same tap that feeds the worklet in the preferred path).
 */
export function createFallbackGraph(
  context: AudioContext,
  input: AudioNode,
  initial: KerbalizerParams
): FallbackGraph {
  const hp = context.createBiquadFilter();
  hp.type = "highpass";
  const lp = context.createBiquadFilter();
  lp.type = "lowpass";
  const peak = context.createBiquadFilter();
  peak.type = "peaking";
  peak.Q.value = 1.1;

  const shaper = context.createWaveShaper();
  shaper.curve = makeTanhCurveForDrive(1.825); // matches new worklet default (drive at strength 0.55)
  shaper.oversample = "2x";

  const dryGain = context.createGain();
  const wetGain = context.createGain();
  const merger = context.createGain();

  input.connect(hp);
  hp.connect(lp);
  lp.connect(peak);
  peak.connect(shaper);
  shaper.connect(wetGain);

  input.connect(dryGain);
  wetGain.connect(merger);
  dryGain.connect(merger);

  function applyParams(p: KerbalizerParams): void {
    const s = Math.max(0, Math.min(1, p.strength));
    const ch = Math.max(0, Math.min(1, p.character));
    const wet = Math.max(0, Math.min(1, p.wet));

    /* Curves intentionally match `KerbalizerProcessor.recompute` in the worklet so
       the user can't tell which DSP path the browser picked. See that file for the
       rationale on each range; tldr: real comms band, gentler peak EQ, less drive. */
    const fHp = 80 + s * 220;            // 80 Hz .. 300 Hz
    const fLp = Math.max(2000, Math.min(12000, 5500 - s * 2300));  // 5500 .. 3200 Hz
    const fPk = 1800 + ch * 1400;        // 1800 .. 3200 Hz
    const pkDb = 2 + s * 7;              // +2 .. +9 dB

    hp.frequency.value = fHp;
    lp.frequency.value = fLp;
    peak.frequency.value = fPk;
    peak.gain.value = pkDb;

    const drive = 1.0 + s * 1.5;         // 1.0 .. 2.5 (was 1.05 .. 3.9 — too hot)
    shaper.curve = makeTanhCurveForDrive(drive);

    if (!p.enabled) {
      dryGain.gain.value = 1;
      wetGain.gain.value = 0;
      return;
    }

    dryGain.gain.value = 1 - wet;
    wetGain.gain.value = wet;
  }

  applyParams(initial);
  return {
    hp,
    lp,
    peak,
    shaper,
    dryGain,
    wetGain,
    merger,
    applyParams
  };
}
