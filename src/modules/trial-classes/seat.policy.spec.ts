import { seatsLeft } from './seat.policy';

describe('seat.policy — seatsLeft', () => {
  it('is zero when full', () => {
    expect(seatsLeft(4, 4)).toBe(0);
  });

  it('returns the remainder', () => {
    expect(seatsLeft(4, 1)).toBe(3);
  });

  it('never goes negative', () => {
    expect(seatsLeft(4, 5)).toBe(0);
  });
});
