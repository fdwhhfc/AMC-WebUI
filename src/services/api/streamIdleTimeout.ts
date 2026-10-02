/**
 * Shared idle watchdog for streaming responses.
 *
 * Streaming has two materially different quiet periods:
 * - before the first response chunk, the model may still be preparing a large
 *   file or doing server-side work, so allow a longer first-event budget;
 * - after streaming has started, a long silent gap is more likely to be a
 *   stalled connection, so use a shorter steady-state idle budget.
 *
 * Defaults:
 * - VITE_STREAM_FIRST_EVENT_TIMEOUT_MS: 300000 ms (5 minutes)
 * - VITE_STREAM_IDLE_TIMEOUT_MS: 120000 ms (2 minutes)
 */
const STREAM_FIRST_EVENT_TIMEOUT_MS = readTimeoutMs('VITE_STREAM_FIRST_EVENT_TIMEOUT_MS', 300_000);
const STREAM_IDLE_TIMEOUT_MS = readTimeoutMs('VITE_STREAM_IDLE_TIMEOUT_MS', 120_000);

function readTimeoutMs(envName: 'VITE_STREAM_FIRST_EVENT_TIMEOUT_MS' | 'VITE_STREAM_IDLE_TIMEOUT_MS', fallback: number): number {
  const raw = import.meta.env?.[envName];
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

export const createStreamIdleTimeoutError = (): Error => {
  const error = new Error('Stream timed out waiting for data.');
  error.name = 'StreamIdleTimeoutError';
  return error;
};

/**
 * Check a stream against the appropriate quiet-period timeout.
 *
 * Before any data is observed, use the first-event budget. Once at least one
 * chunk has arrived, use the steady-state idle budget.
 */
export const hasStreamIdleTimeoutElapsed = (
  lastActivityAt: number,
  hasReceivedData = true,
  now = Date.now(),
): boolean => {
  const timeoutMs = hasReceivedData ? STREAM_IDLE_TIMEOUT_MS : STREAM_FIRST_EVENT_TIMEOUT_MS;
  return now - lastActivityAt > timeoutMs;
};
