import { describe, expect, it } from 'vitest';

import { toSubunits } from '../lib/amount';

describe('toSubunits', () => {
  it('converts to the smallest currency unit', () => {
    expect(toSubunits(10.5, 'INR')).toBe(1050);
    expect(toSubunits(0.1 + 0.2, 'USD')).toBe(30);
  });

  it('keeps currencies without subunits', () => {
    expect(toSubunits(1200, 'JPY')).toBe(1200);
  });

  it('uses three decimals for currencies that have them', () => {
    expect(toSubunits(1.234, 'KWD')).toBe(1234);
    expect(toSubunits(1.234, 'kwd')).toBe(1234);
  });
});
