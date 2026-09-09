import { BookingOutcome } from '../enums/booking-outcome.enum';
import { ErrorCode } from '../enums/error-code.enum';
import { messageFor } from './error-messages';

describe('messageFor', () => {
  it('returns the mapped copy for a known booking outcome', () => {
    expect(messageFor(BookingOutcome.ClassFull)).toBe(
      'Sorry, that seat was just taken.',
    );
  });

  it('returns the mapped copy for a known error code', () => {
    expect(messageFor(ErrorCode.LockTimeout)).toBe(
      'The system is busy, retry shortly.',
    );
  });

  it('falls back to a generic message for an unknown code', () => {
    expect(messageFor('WHATEVER')).toBe('Something went wrong.');
  });
});
