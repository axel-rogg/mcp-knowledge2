import { describe, expect, it } from 'vitest';
import { maskPII } from '../../src/lib/pii/mask.ts';

describe('maskPII', () => {
  it('masks email addresses', () => {
    expect(maskPII('contact axel@example.com today')).toContain('[EMAIL]');
  });
  it('masks UUIDs', () => {
    expect(maskPII('see 550e8400-e29b-41d4-a716-446655440000')).toContain('[UUID]');
  });
  it('masks IBANs', () => {
    expect(maskPII('IBAN: CH9300762011623852957')).toContain('[IBAN]');
  });
  it('masks credit card numbers', () => {
    expect(maskPII('card 4111-1111-1111-1111')).toContain('[CC]');
  });
  it('masks phone numbers', () => {
    expect(maskPII('call +41 79 555 1234')).toContain('[PHONE]');
  });
  it('masks IPv4 addresses', () => {
    expect(maskPII('host 10.0.0.1')).toContain('[IP]');
  });
  it('masks URLs', () => {
    expect(maskPII('see https://example.com/page')).toContain('[URL]');
  });
  it('is deterministic', () => {
    const a = maskPII('user a@b.com from 1.2.3.4');
    const b = maskPII('user a@b.com from 1.2.3.4');
    expect(a).toBe(b);
  });
});
