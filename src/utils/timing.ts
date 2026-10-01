/**
 * Timing helpers with injectable behavior for tests.
 * Production timeouts must not be confused with intentional delays.
 */

export type SleepFn = (ms: number) => Promise<void>;

/** Default sleep that resolves after ms. */
export const sleep: SleepFn = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/** Allow tests to replace sleep without breaking withTimeout races. */
let sleepImpl: SleepFn = sleep;

export function setSleepFn(fn: SleepFn | null): void {
  sleepImpl = fn ?? sleep;
}

export function getSleepFn(): SleepFn {
  return sleepImpl;
}

export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Race a promise against a timeout. The timer uses the *real* setTimeout so
 * tests that stub sleep/delays do not accidentally win the race.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = `Operation timed out after ${ms}ms`
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), Math.max(1, ms));
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
