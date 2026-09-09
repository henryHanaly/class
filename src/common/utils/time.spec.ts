import { isPast, now, sleep } from './time';

describe('time', () => {
  it('now() returns the current Date', () => {
    const before = Date.now();
    const value = now();
    expect(value).toBeInstanceOf(Date);
    expect(value.getTime()).toBeGreaterThanOrEqual(before);
    expect(value.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('isPast() is true for a past date and false for a future one', () => {
    expect(isPast(new Date(Date.now() - 1000))).toBe(true);
    expect(isPast(new Date(Date.now() + 60_000))).toBe(false);
  });

  it('sleep() resolves after roughly the requested delay', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
