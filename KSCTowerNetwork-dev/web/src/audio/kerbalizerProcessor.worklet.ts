// @ts-nocheck — AudioWorkletProcessor typings vary by TS lib; runtime is valid in browsers.
// AudioWorklet runs in a separate global scope; keep self-contained.

type BiquadCoeffs = { b0: number; b1: number; b2: number; a1: number; a2: number };
type BiquadState = { z1: number; z2: number };

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoeffs {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function coeffsLowpass(f0: number, fs: number, Q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);
  const b0 = (1 - cosw0) / 2;
  const b1 = 1 - cosw0;
  const b2 = (1 - cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return norm(b0, b1, b2, a0, a1, a2);
}

function coeffsHighpass(f0: number, fs: number, Q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);
  const b0 = (1 + cosw0) / 2;
  const b1 = -(1 + cosw0);
  const b2 = (1 + cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return norm(b0, b1, b2, a0, a1, a2);
}

function coeffsPeaking(f0: number, fs: number, Q: number, dBgain: number): BiquadCoeffs {
  const A = Math.pow(10, dBgain / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);
  const b0 = 1 + alpha * A;
  const b1 = -2 * cosw0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha / A;
  return norm(b0, b1, b2, a0, a1, a2);
}

function biquadDF2T(x: number, c: BiquadCoeffs, st: BiquadState): number {
  const y = c.b0 * x + st.z1;
  st.z1 = c.b1 * x - c.a1 * y + st.z2;
  st.z2 = c.b2 * x - c.a2 * y;
  return y;
}

class KerbalizerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "bypass", defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: "wet", defaultValue: 0.85, minValue: 0, maxValue: 1 },
      { name: "strength", defaultValue: 0.55, minValue: 0, maxValue: 1 },
      { name: "character", defaultValue: 0.55, minValue: 0, maxValue: 1 },
      { name: "kerbal", defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: "pitch", defaultValue: 6, minValue: 0, maxValue: 12 }
    ];
  }

  private hp: BiquadCoeffs;
  private lp: BiquadCoeffs;
  private pk: BiquadCoeffs;
  private stHp: BiquadState = { z1: 0, z2: 0 };
  private stLp: BiquadState = { z1: 0, z2: 0 };
  private stPk: BiquadState = { z1: 0, z2: 0 };
  private lastKey = -1;

  /* ------------- Granular pitch shifter (two-tap, Hann-windowed) -------------
     Ring buffer holds the post-EQ/saturation signal. Two read taps lag the
     write head by `gap1` and `gap2` samples (offset by GRAIN/2 so their Hann
     windows sum to ~1). Each output sample, every gap shrinks by (ratio-1)
     for upshift; when a gap leaves [0, GRAIN] it wraps by ±GRAIN. The Hann
     window is zero at the wrap moment, so the ±GRAIN read-head jump is
     inaudible. This is the standard "two-tap crossfading delay" pitch shifter
     (cousin of SOLA), good enough for chipmunky voice in real-time. */
  private static readonly PITCH_BUF_LEN = 4096;
  private static readonly PITCH_GRAIN = 1024;
  private pitchBuf = new Float32Array(KerbalizerProcessor.PITCH_BUF_LEN);
  private pbWrite = 0;
  private pbGap1 = KerbalizerProcessor.PITCH_GRAIN;
  private pbGap2 = KerbalizerProcessor.PITCH_GRAIN * 0.5;

  constructor() {
    super();
    const fs = sampleRate;
    this.hp = coeffsHighpass(120, fs, 0.707);
    this.lp = coeffsLowpass(8000, fs, 0.707);
    this.pk = coeffsPeaking(2400, fs, 1, 4);
  }

  private pitchRead(gap: number): number {
    const N = KerbalizerProcessor.PITCH_BUF_LEN;
    const pos = this.pbWrite - gap;
    let p = pos % N;
    if (p < 0) p += N;
    const i0 = p | 0;
    const frac = p - i0;
    const i1 = i0 + 1 >= N ? 0 : i0 + 1;
    return this.pitchBuf[i0]! * (1 - frac) + this.pitchBuf[i1]! * frac;
  }

  private recompute(strength: number, character: number): void {
    const fs = sampleRate;
    const s = Math.max(0, Math.min(1, strength));
    const ch = Math.max(0, Math.min(1, character));
    /* Comms-radio chain. At strength=0 the filters sit out of the way so the
       chain is mostly transparent (just tilt + tiny presence). At strength=1
       we land in classic 1960s-handheld-radio territory: ~300 Hz HP, ~3 kHz
       LP, healthy presence peak. The LP floor is intentionally above 2 kHz
       so consonants stay legible — drop below that and intelligibility dies. */
    const fHp = 80 + s * 220;            // 80 Hz .. 300 Hz
    const fLp = 5500 - s * 2300;         // 5500 Hz .. 3200 Hz (was 11.5k..3.7k — way too bright)
    const fPk = 1800 + ch * 1400;        // 1800 Hz .. 3200 Hz, controlled by `character`
    const pkDb = 2 + s * 7;              // +2 .. +9 dB (was up to +13 — fizzy when driven)
    this.hp = coeffsHighpass(fHp, fs, 0.707);
    this.lp = coeffsLowpass(Math.max(2000, Math.min(12000, fLp)), fs, 0.707);
    this.pk = coeffsPeaking(fPk, fs, 1.1, pkDb);
    this.stHp = { z1: 0, z2: 0 };
    this.stLp = { z1: 0, z2: 0 };
    this.stPk = { z1: 0, z2: 0 };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.[0] || !output?.[0]) {
      return true;
    }

    const chIn = input[0];
    const chOut = output[0];
    const n = chIn.length;

    const bypass = parameters.bypass;
    const wetP = parameters.wet;
    const strP = parameters.strength;
    const charP = parameters.character;
    const kerbP = parameters.kerbal;
    const pitchP = parameters.pitch;

    const bp = bypass.length > 1 ? bypass[bypass.length - 1]! : bypass[0]!;
    const wet = wetP.length > 1 ? wetP[wetP.length - 1]! : wetP[0]!;
    const strength = strP.length > 1 ? strP[strP.length - 1]! : strP[0]!;
    const character = charP.length > 1 ? charP[charP.length - 1]! : charP[0]!;
    const kerbal = kerbP.length > 1 ? kerbP[kerbP.length - 1]! : kerbP[0]!;
    const pitchSt = pitchP.length > 1 ? pitchP[pitchP.length - 1]! : pitchP[0]!;

    const key = ((strength * 1000) | 0) * 10000 + ((character * 1000) | 0);
    if (key !== this.lastKey) {
      this.recompute(strength, character);
      this.lastKey = key;
    }

    if (bp >= 0.5) {
      chOut.set(chIn);
      return true;
    }

    /* `drive` is the input gain into the tanh saturator. Old curve (1.05..3.9)
       was too hot — combined with the +8 dB peak EQ the saturator was clipping
       hard on every vowel. New range gives "warm coloration" at default and
       "obvious comms saturation" at full, without ever sounding fizzy. */
    const drive = 1.0 + strength * 1.5;  // 1.0 .. 2.5
    /* Normalize tanh so peak amplitude stays at unity regardless of drive.
       Without this, raising `strength` made the wet path noticeably louder
       than the dry, so the wet/dry mix was a loudness mix not a character mix. */
    const tanhNorm = 1 / Math.tanh(drive);
    const w = Math.max(0, Math.min(1, wet));
    const kerbalOn = kerbal >= 0.5 && pitchSt > 0.01;
    const ratio = kerbalOn ? Math.pow(2, pitchSt / 12) : 1;
    const delta = ratio - 1; // gap shrinks at this rate per output sample for upshift
    const G = KerbalizerProcessor.PITCH_GRAIN;
    const N = KerbalizerProcessor.PITCH_BUF_LEN;
    /* Pitching up makes loud passages louder (energy is replayed faster). Trim
       output by 1/sqrt(ratio) so a +6 st shift doesn't blow past the limiter. */
    const pitchTrim = kerbalOn ? 1 / Math.sqrt(ratio) : 1;

    for (let i = 0; i < n; i++) {
      const dry = chIn[i]!;
      let x = dry;
      x = biquadDF2T(x, this.hp, this.stHp);
      x = biquadDF2T(x, this.lp, this.stLp);
      x = biquadDF2T(x, this.pk, this.stPk);
      let shaped = Math.tanh(x * drive) * tanhNorm;

      if (kerbalOn) {
        this.pitchBuf[this.pbWrite] = shaped;
        this.pbWrite = this.pbWrite + 1 >= N ? 0 : this.pbWrite + 1;

        const s1 = this.pitchRead(this.pbGap1);
        const s2 = this.pitchRead(this.pbGap2);
        const w1 = 0.5 - 0.5 * Math.cos((2 * Math.PI * this.pbGap1) / G);
        const w2 = 0.5 - 0.5 * Math.cos((2 * Math.PI * this.pbGap2) / G);
        shaped = (s1 * w1 + s2 * w2) * pitchTrim;

        this.pbGap1 -= delta;
        this.pbGap2 -= delta;
        if (this.pbGap1 <= 0) this.pbGap1 += G;
        else if (this.pbGap1 >= G) this.pbGap1 -= G;
        if (this.pbGap2 <= 0) this.pbGap2 += G;
        else if (this.pbGap2 >= G) this.pbGap2 -= G;
      }

      chOut[i] = dry * (1 - w) + shaped * w;
    }

    return true;
  }
}

registerProcessor("ksc-kerbalizer", KerbalizerProcessor);
