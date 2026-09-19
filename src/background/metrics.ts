import type { RequestStats, SessionStats } from "../shared/types.js";

const RING = 40;

const ttfts: number[] = [];
let requests = 0;
let accepted = 0;
let freeHits = 0;

/** Most recent request, kept for the HUD's prompt inspector. */
export let lastRequest: RequestStats | null = null;

export function recordRequest(stats: RequestStats): void {
  requests++;
  lastRequest = stats;
  if (stats.cached) {
    freeHits++;
    return;
  }
  ttfts.push(stats.ttft);
  if (ttfts.length > RING) ttfts.shift();
}

export function recordAccept(): void {
  accepted++;
}

export function recordFreeHit(): void {
  freeHits++;
}

let predictions = 0;
let actionsAccepted = 0;

export function recordPrediction(): void {
  predictions++;
}

export function recordActionAccepted(): void {
  actionsAccepted++;
}

export function sessionStats(): SessionStats {
  const sorted = [...ttfts].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return {
    requests,
    accepted,
    freeHits,
    medianTtft: Math.round(median),
    predictions,
    actionsAccepted,
  };
}
