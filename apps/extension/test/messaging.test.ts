import { describe, expect, it } from 'vitest';
import { onMessage, sendMessage } from '../src/messaging';

describe('messaging', () => {
  it('exposes a typed send/receive pair', () => {
    expect(typeof sendMessage).toBe('function');
    expect(typeof onMessage).toBe('function');
    expect(typeof document).toBe('object');
  });
});
