import workletUrl from "./kerbalizerProcessor.worklet.ts?url";
import { analyserRmsNormalized } from "./meters";
import { createFallbackGraph } from "./kerbalizerFallback";
import {
  DEFAULT_KERBALIZER_PARAMS,
  type KerbalizerHandle,
  type KerbalizerMeters,
  type KerbalizerMode,
  type KerbalizerParams
} from "./types";

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function clampPitchSt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(12, n));
}

function mergeParams(base: KerbalizerParams, partial: Partial<KerbalizerParams>): KerbalizerParams {
  return {
    enabled: partial.enabled ?? base.enabled,
    strength: clamp01(partial.strength ?? base.strength),
    wet: clamp01(partial.wet ?? base.wet),
    character: clamp01(partial.character ?? base.character),
    kerbalVoice: partial.kerbalVoice ?? base.kerbalVoice,
    pitchSemitones: clampPitchSt(partial.pitchSemitones ?? base.pitchSemitones)
  };
}

export type CreateKerbalizerOptions = {
  /** Existing AudioContext, or a new one is created. */
  audioContext?: AudioContext;
  initialParams?: Partial<KerbalizerParams>;
};

type KerbalizerDspBridge = {
  analyserIn: AnalyserNode;
  analyserOut: AnalyserNode;
  setParams: (partial: Partial<KerbalizerParams>) => void;
  disposeBridge: () => void;
  mode: KerbalizerMode;
};

async function createKerbalizerDspBridge(
  context: AudioContext,
  initialParams: KerbalizerParams
): Promise<KerbalizerDspBridge> {
  let params: KerbalizerParams = mergeParams(DEFAULT_KERBALIZER_PARAMS, initialParams);

  const analyserIn = context.createAnalyser();
  analyserIn.fftSize = 2048;
  const analyserOut = context.createAnalyser();
  analyserOut.fftSize = 2048;

  let mode: KerbalizerMode = "fallback";
  let workletNode: AudioWorkletNode | null = null;
  let fallback: ReturnType<typeof createFallbackGraph> | null = null;

  try {
    await context.audioWorklet.addModule(workletUrl);
    workletNode = new AudioWorkletNode(context, "ksc-kerbalizer", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1
    });

    applyWorkletParams(workletNode, params);

    analyserIn.connect(workletNode);
    workletNode.connect(analyserOut);
    mode = "worklet";
  } catch {
    workletNode = null;
    fallback = createFallbackGraph(context, analyserIn, params);
    fallback.merger.connect(analyserOut);
    mode = "fallback";
  }

  function setParams(partial: Partial<KerbalizerParams>): void {
    params = mergeParams(params, partial);
    if (mode === "worklet" && workletNode) {
      applyWorkletParams(workletNode, params);
    } else if (fallback) {
      fallback.applyParams(params);
    }
  }

  function disposeBridge(): void {
    try {
      analyserIn.disconnect();
    } catch {
      /* ignore */
    }
    try {
      analyserOut.disconnect();
    } catch {
      /* ignore */
    }
    if (workletNode) {
      try {
        workletNode.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (fallback) {
      try {
        fallback.hp.disconnect();
        fallback.lp.disconnect();
        fallback.peak.disconnect();
        fallback.shaper.disconnect();
        fallback.dryGain.disconnect();
        fallback.wetGain.disconnect();
        fallback.merger.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  return { analyserIn, analyserOut, setParams, disposeBridge, mode };
}

export type KerbalizerSpeakerHandle = {
  readonly audioContext: AudioContext;
  /** Connect MediaElementSource, MediaStreamSource, or AudioBufferSource here. */
  readonly input: AnalyserNode;
  readonly mode: KerbalizerMode;
  readonly ownsContext: boolean;
  setParams: (partial: Partial<KerbalizerParams>) => void;
  getParams: () => KerbalizerParams;
  dispose: () => void;
};

/**
 * Kerbalizer send-path DSP wired to the AudioContext speakers (destination).
 * Caller connects a source into `input` (same tap as mic publish path).
 */
export async function createKerbalizerSpeakerSession(
  options: CreateKerbalizerOptions = {}
): Promise<KerbalizerSpeakerHandle> {
  const ownsContext = !options.audioContext;
  const context = options.audioContext ?? new AudioContext();
  let params: KerbalizerParams = mergeParams(DEFAULT_KERBALIZER_PARAMS, options.initialParams ?? {});

  const bridge = await createKerbalizerDspBridge(context, params);
  bridge.analyserOut.connect(context.destination);

  if (context.state === "suspended") {
    await context.resume();
  }

  function setParams(partial: Partial<KerbalizerParams>): void {
    params = mergeParams(params, partial);
    bridge.setParams(partial);
  }

  function getParams(): KerbalizerParams {
    return { ...params };
  }

  function dispose(): void {
    try {
      bridge.analyserOut.disconnect();
    } catch {
      /* ignore */
    }
    bridge.disposeBridge();
    if (ownsContext) {
      void context.close();
    }
  }

  return {
    audioContext: context,
    input: bridge.analyserIn,
    mode: bridge.mode,
    ownsContext,
    setParams,
    getParams,
    dispose
  };
}

/**
 * Wraps a mic (or any) audio track with Kerbalizer send-path processing.
 * Returns a new MediaStreamTrack suitable for LiveKit `LocalParticipant.publishTrack`.
 *
 * Uses AudioWorklet when available; otherwise main-thread Biquad + WaveShaper.
 */
export async function createKerbalizerTrack(
  inputTrack: MediaStreamTrack,
  options: CreateKerbalizerOptions = {}
): Promise<KerbalizerHandle> {
  let params: KerbalizerParams = mergeParams(DEFAULT_KERBALIZER_PARAMS, options.initialParams ?? {});

  const context = options.audioContext ?? new AudioContext();
  const stream = new MediaStream([inputTrack]);
  const source = context.createMediaStreamSource(stream);

  const destination = context.createMediaStreamDestination();

  const bridge = await createKerbalizerDspBridge(context, params);
  source.connect(bridge.analyserIn);
  bridge.analyserOut.connect(destination);

  const { analyserIn, analyserOut, setParams: bridgeSetParams, disposeBridge, mode } = bridge;

  const outTracks = destination.stream.getAudioTracks();
  const outputTrack = outTracks[0];
  if (!outputTrack) {
    disposeBridge();
    void context.close();
    throw new Error("Kerbalizer: MediaStreamDestination produced no audio track");
  }

  if (context.state === "suspended") {
    await context.resume();
  }

  let meters: KerbalizerMeters = { input: 0, output: 0 };
  const meterSubs = new Set<(m: KerbalizerMeters) => void>();
  let rafId: number | null = null;

  function tickMeters(): void {
    meters = {
      input: analyserRmsNormalized(analyserIn),
      output: analyserRmsNormalized(analyserOut)
    };
    for (const fn of meterSubs) {
      fn(meters);
    }
    rafId = requestAnimationFrame(tickMeters);
  }

  rafId = requestAnimationFrame(tickMeters);

  function setParams(partial: Partial<KerbalizerParams>): void {
    params = mergeParams(params, partial);
    bridgeSetParams(partial);
  }

  function getParams(): KerbalizerParams {
    return { ...params };
  }

  function getMeters(): KerbalizerMeters {
    return meters;
  }

  function subscribeMeters(fn: (m: KerbalizerMeters) => void): () => void {
    meterSubs.add(fn);
    return () => {
      meterSubs.delete(fn);
    };
  }

  function dispose(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    meterSubs.clear();
    try {
      source.disconnect();
    } catch {
      /* ignore */
    }
    disposeBridge();
    void context.close();
  }

  return {
    outputTrack,
    inputTrack,
    mode,
    setParams,
    getParams,
    getMeters,
    subscribeMeters,
    dispose
  };
}

function applyWorkletParams(node: AudioWorkletNode, p: KerbalizerParams): void {
  const bypass = p.enabled ? 0 : 1;
  const wet = clamp01(p.wet);
  const strength = clamp01(p.strength);
  const character = clamp01(p.character);
  const kerbal = p.kerbalVoice ? 1 : 0;
  const pitch = clampPitchSt(p.pitchSemitones);

  const map: Record<string, number> = { bypass, wet, strength, character, kerbal, pitch };
  for (const name of Object.keys(map)) {
    const param = node.parameters.get(name);
    if (param) {
      param.value = map[name]!;
    }
  }
}
