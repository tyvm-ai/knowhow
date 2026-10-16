
/** Summarise per-frame RMS values for the ambient noise-floor log. */
export function summariseNoiseFloor(
  rmsValues: readonly number[],
  threshold: number,
): { p10: number; median: number; p90: number; aboveThresholdPct: number } | undefined {
  if (!rmsValues.length) return undefined;
  const sorted = [...rmsValues].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const above = rmsValues.filter((v) => v >= threshold).length;
  return {
    p10: at(0.1),
    median: at(0.5),
    p90: at(0.9),
    aboveThresholdPct: Math.round((above / rmsValues.length) * 1000) / 10,
  };
}

export function frameDurationMs(frame: Buffer, sampleRate: number, channels: number): number {
  return (frame.length / (2 * channels * sampleRate)) * 1000;
}

export function pcmRms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let squareSum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset) / 32768;
    squareSum += value * value;
  }
  return Math.sqrt(squareSum / samples);
}
