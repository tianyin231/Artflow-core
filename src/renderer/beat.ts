/**
 * BGM beat detection + cut snapping (F2-M3).
 */
export interface BeatGrid {
  bpm: number;
  beatSec: number[];
}

/** Detect BPM from an onset strength array (simple autocorrelation). */
export function detectBpm(onsets: number[], sampleRate = 100): number {
  if (onsets.length < 16) return 120;
  let bestBpm = 120;
  let bestScore = -1;
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const period = (60 / bpm) * sampleRate;
    let score = 0;
    for (let i = 0; i < onsets.length; i++) {
      const j = Math.round(i + period);
      if (j < onsets.length) score += onsets[i] * onsets[j];
    }
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  return Math.round(bestBpm * 10) / 10;
}

/** Build a click-track onset array at the given BPM. */
export function clickOnsets(bpm: number, seconds: number, sampleRate = 100): number[] {
  const period = (60 / bpm) * sampleRate;
  const n = Math.floor(seconds * sampleRate);
  const arr = new Array(n).fill(0);
  for (let i = 0; i < n; i += period) {
    arr[Math.floor(i)] = 1;
  }
  return arr;
}

export function buildBeatGrid(bpm: number, durationSec: number): BeatGrid {
  const beatSec: number[] = [];
  const period = 60 / bpm;
  for (let t = 0; t <= durationSec; t += period) beatSec.push(Math.round(t * 1000) / 1000);
  return { bpm, beatSec };
}

/** Snap cut times to nearest beat. Returns new cuts and mean deviation ms. */
export function snapCutsToBeats(
  cutsSec: number[],
  grid: BeatGrid,
  toleranceMs = 80
): { cuts: number[]; meanDeviationMs: number } {
  const cuts = cutsSec.map((c) => {
    let best = c;
    let bestDist = Infinity;
    for (const b of grid.beatSec) {
      const d = Math.abs(c - b) * 1000;
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return bestDist <= toleranceMs ? best : c;
  });
  const dev =
    cutsSec.length === 0
      ? 0
      : cutsSec.reduce((s, c, i) => s + Math.abs(c - cuts[i]) * 1000, 0) / cutsSec.length;
  return { cuts, meanDeviationMs: Math.round(dev * 100) / 100 };
}
