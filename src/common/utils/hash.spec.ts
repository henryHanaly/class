import { bodyHash, canonicalBookingJson } from './hash';

describe('hash — bodyHash', () => {
  const base = {
    parentId: 'p1',
    childId: 'c1',
    classId: 'cl1',
    simulatePayment: 'success',
  };

  it('is independent of field order in the input object', () => {
    const reordered = {
      simulatePayment: 'success',
      classId: 'cl1',
      childId: 'c1',
      parentId: 'p1',
    };
    expect(bodyHash(reordered)).toBe(bodyHash(base));
  });

  it('changes when simulatePayment changes', () => {
    expect(bodyHash({ ...base, simulatePayment: 'fail' })).not.toBe(
      bodyHash(base),
    );
  });

  it('ignores unknown fields (only the canonical four count)', () => {
    expect(bodyHash({ ...base, extra: 'x' } as never)).toBe(bodyHash(base));
  });

  it('canonical json defaults every missing field to null', () => {
    expect(canonicalBookingJson({})).toBe(
      '{"parentId":null,"childId":null,"classId":null,"simulatePayment":null}',
    );
    expect(typeof bodyHash({})).toBe('string');
  });

  it('canonical json uses a fixed key order', () => {
    expect(canonicalBookingJson(base)).toBe(
      '{"parentId":"p1","childId":"c1","classId":"cl1","simulatePayment":"success"}',
    );
  });
});
