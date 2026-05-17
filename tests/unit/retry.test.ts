import { describe, expect, it } from 'vitest';
import { defaultIsRetryable, retryWithBackoff } from '../../src/lib/retry.ts';

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, msg = `HTTP ${status}`) {
    super(msg);
    this.status = status;
  }
}

describe('defaultIsRetryable', () => {
  it('retries 5xx', () => {
    expect(defaultIsRetryable(new HttpError(500))).toBe(true);
    expect(defaultIsRetryable(new HttpError(503))).toBe(true);
    expect(defaultIsRetryable(new HttpError(599))).toBe(true);
  });
  it('retries 429', () => {
    expect(defaultIsRetryable(new HttpError(429))).toBe(true);
  });
  it('does NOT retry 4xx (except 429)', () => {
    expect(defaultIsRetryable(new HttpError(400))).toBe(false);
    expect(defaultIsRetryable(new HttpError(401))).toBe(false);
    expect(defaultIsRetryable(new HttpError(403))).toBe(false);
    expect(defaultIsRetryable(new HttpError(404))).toBe(false);
  });
  it('retries network failures (TypeError)', () => {
    expect(defaultIsRetryable(new TypeError('fetch failed'))).toBe(true);
  });
  it('parses status out of error message', () => {
    expect(defaultIsRetryable(new Error('upstream failed: 503'))).toBe(true);
    expect(defaultIsRetryable(new Error('bad input: 400'))).toBe(false);
  });
});

describe('retryWithBackoff', () => {
  it('returns the value on first success', async () => {
    let calls = 0;
    const result = await retryWithBackoff(async () => {
      calls++;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on retryable error then succeeds', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new HttpError(503);
        return 'recovered';
      },
      { baseDelayMs: 1, maxDelayMs: 5 },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('stops retrying after maxAttempts and throws the last error', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new HttpError(503);
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toThrow('HTTP 503');
    expect(calls).toBe(3);
  });

  it('does NOT retry 4xx — fails immediately', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new HttpError(401);
        },
        { maxAttempts: 5, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('HTTP 401');
    expect(calls).toBe(1);
  });

  it('respects totalBudgetMs', async () => {
    let calls = 0;
    const start = Date.now();
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new HttpError(503);
        },
        { maxAttempts: 10, baseDelayMs: 20, maxDelayMs: 100, totalBudgetMs: 50 },
      ),
    ).rejects.toThrow('HTTP 503');
    const elapsed = Date.now() - start;
    // Budget=50ms means we should bail well before the 10th attempt
    expect(calls).toBeLessThan(10);
    expect(elapsed).toBeLessThan(200);
  });

  it('calls onRetry hook between attempts', async () => {
    const retries: number[] = [];
    await expect(
      retryWithBackoff(
        async () => {
          throw new HttpError(503);
        },
        {
          maxAttempts: 3,
          baseDelayMs: 1,
          onRetry: (attempt) => retries.push(attempt),
        },
      ),
    ).rejects.toThrow();
    // onRetry fires between attempts → 2 calls for 3 attempts total
    expect(retries).toEqual([1, 2]);
  });
});
