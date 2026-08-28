export function nextReconnectDelay(current: number, max: number, factor = 1.5): number {
  return Math.min(current * factor, max);
}

export interface BackoffScheduler {
  readonly delay: number;
  grow(): void;
  reset(): void;
}

export function createBackoffScheduler(initialMs: number, maxMs: number, factor = 1.5): BackoffScheduler {
  let delay = initialMs;
  return {
    get delay(): number {
      return delay;
    },
    grow(): void {
      delay = nextReconnectDelay(delay, maxMs, factor);
    },
    reset(): void {
      delay = initialMs;
    },
  };
}
