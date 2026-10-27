import { describe, expect, it } from 'vitest';
import { errorMessage, SESSION_EXPIRED_MESSAGE } from './errors';

describe('errorMessage', () => {
  it('keeps the message of a the internal gateway plain-object rejection (measured shape 2026-09-25)', () => {
    const harmony = { name: 'Error', message: "The IAM role arn:aws:iam::111122223333:role/PortalInvokeRole cannot be assumed since it's not registered with the internal gateway.", retryable: false };
    expect(errorMessage(harmony, 'cluster API unavailable')).toContain('not registered with the internal gateway');
  });

  it('keeps Error messages', () => {
    expect(errorMessage(new Error('HTTP 403'), 'fallback')).toBe('HTTP 403');
  });

  it('falls back only when there is nothing to show', () => {
    expect(errorMessage(undefined, 'fallback')).toBe('fallback');
    expect(errorMessage({ message: '' }, 'fallback')).toBe('fallback');
    expect(errorMessage(new Error(''), 'fallback')).toBe('fallback');
  });

  it('turns the minified "x.json is not a function" of a missing the corporate SSO session into an actionable cause', () => {
    expect(errorMessage(new TypeError('h.json is not a function'), 'fallback')).toBe(SESSION_EXPIRED_MESSAGE);
    expect(errorMessage(new TypeError('xy.text is not a function'), 'fallback')).toBe(SESSION_EXPIRED_MESSAGE);
    expect(SESSION_EXPIRED_MESSAGE).toContain('reload the page');
  });

  it('keeps every other TypeError and plain message untouched (negative control)', () => {
    expect(errorMessage(new TypeError('Failed to fetch'), 'fallback')).toBe('Failed to fetch');
    expect(errorMessage(new Error('h.json is not a function'), 'fallback')).toBe('h.json is not a function');
    expect(errorMessage({ message: 'h.json is not a function' }, 'fallback')).toBe('h.json is not a function');
  });
});
