import { describe, expect, it } from 'vitest';
import { hasStreamIdleTimeoutElapsed } from './streamIdleTimeout';

describe('streamIdleTimeout', () => {
  it('uses a 5-minute budget before the first chunk', () => {
    expect(hasStreamIdleTimeoutElapsed(0, false, 299_999)).toBe(false);
    expect(hasStreamIdleTimeoutElapsed(0, false, 300_001)).toBe(true);
  });

  it('uses a 2-minute budget after streaming has started', () => {
    expect(hasStreamIdleTimeoutElapsed(0, true, 119_999)).toBe(false);
    expect(hasStreamIdleTimeoutElapsed(0, true, 120_001)).toBe(true);
  });
});
