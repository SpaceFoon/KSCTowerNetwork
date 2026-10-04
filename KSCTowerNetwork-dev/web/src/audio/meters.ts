let meterScratch = new Float32Array(2048);

/**
 * RMS of time-domain samples, normalized to a rough 0–1 VU-style value for UI.
 */
export function analyserRmsNormalized(analyser: AnalyserNode): number {
  const size = analyser.fftSize;
  if (meterScratch.length < size) {
    meterScratch = new Float32Array(size);
  }
  analyser.getFloatTimeDomainData(meterScratch.subarray(0, size));
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const s = meterScratch[i]!;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / size);
  const boosted = Math.min(1, rms * 4.5);
  return boosted;
}
