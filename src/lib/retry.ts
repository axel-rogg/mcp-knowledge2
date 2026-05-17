// Exponential-backoff retry helper for external API calls (embeddings, KMS).
//
// Why this exists: the embedding adapters call third-party APIs (Cloudflare
// Workers AI, Vertex AI) — both can return 5xx during platform maintenance
// or temporary outages. A single-shot call fails the user's request even
// though a retry would have succeeded.
//
// Critical design choices:
//   - **Cap retries hard** (default 3). No infinite loops, no exponential
//     pile-up that turns into cost-explosion when the upstream stays down.
//   - **Only retry on retryable errors** (network failure, 5xx, 429). NEVER
//     retry 4xx — a 400/401/403 is a deterministic client error and a
//     retry just doubles the cost without changing the result.
//   - **Jitter** on backoff so concurrent failures don't all wake at once.
//   - **Total budget cap** in milliseconds — a request hanging for 30 s + 3
//     retries of 30 s each would exceed Cloud Run's 60 s timeout. Hard cap
//     so the call cannot eat the entire request budget.

export interface RetryOptions {
  /** Max attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Base delay before first retry, in ms. Default 200. */
  baseDelayMs?: number;
  /** Maximum delay between retries, in ms. Default 5000. */
  maxDelayMs?: number;
  /** Total wall-clock budget for all attempts, in ms. Default 30_000. */
  totalBudgetMs?: number;
  /** Predicate: should this error be retried? Default: 5xx + network errors. */
  isRetryable?: (err: unknown) => boolean;
  /** Optional hook called before each retry (for logging). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

/** Default-classifies an error as retryable: network failures and 5xx/429. */
export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof TypeError) {
    // fetch() in Node throws TypeError for network failures (DNS, ECONNRESET, etc.)
    return true;
  }
  const status = (err as { status?: number; statusCode?: number; httpStatus?: number })?.status
    ?? (err as { statusCode?: number }).statusCode
    ?? (err as { httpStatus?: number }).httpStatus;
  if (typeof status === 'number') {
    return status >= 500 || status === 429;
  }
  // Look for HTTP status in error messages produced by our adapters: "... 503 Service Unavailable"
  const msg = String((err as Error)?.message ?? '');
  return /\b(429|5\d\d)\b/.test(msg);
}

/**
 * Run `fn` with exponential-backoff retry. Returns the resolved value or
 * throws the last error after the budget / attempt-cap is reached.
 *
 * Backoff schedule (default): 200 ms, 400 ms, 800 ms, 1600 ms, ..., capped
 * at `maxDelayMs`. Each delay is jittered by ±25% to avoid thundering-herd.
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const totalBudgetMs = opts.totalBudgetMs ?? 30_000;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const start = Date.now();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      if (!isRetryable(err)) break;
      // Exponential backoff with ±25% jitter, capped at maxDelayMs.
      const raw = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = raw * (0.75 + Math.random() * 0.5);
      const delayMs = Math.round(jitter);
      // Check total-budget BEFORE sleeping — don't spend ~30 s waiting just
      // to fail immediately on the next attempt anyway.
      const elapsedAfterDelay = Date.now() - start + delayMs;
      if (elapsedAfterDelay >= totalBudgetMs) break;
      opts.onRetry?.(attempt, err, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
