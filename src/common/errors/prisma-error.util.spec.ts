import { Prisma } from '@prisma/client';
import { isLockTimeout, isUniqueViolationOn } from './prisma-error.util';

const known = (
  code: string,
  meta?: Record<string, unknown>,
  message = 'x',
): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: '5.22.0',
    meta,
  });

describe('isUniqueViolationOn', () => {
  const INDEX = 'one_active_booking_per_child_class';

  it('is true for P2002 on the named index (array target)', () => {
    expect(isUniqueViolationOn(known('P2002', { target: [INDEX] }), INDEX)).toBe(
      true,
    );
  });

  it('is true for P2002 on the named index (string target)', () => {
    expect(isUniqueViolationOn(known('P2002', { target: INDEX }), INDEX)).toBe(
      true,
    );
  });

  it('is false for P2002 on a different constraint', () => {
    expect(
      isUniqueViolationOn(known('P2002', { target: ['parents_email_key'] }), INDEX),
    ).toBe(false);
  });

  it('is false for a non-P2002 error and for plain errors', () => {
    expect(isUniqueViolationOn(known('P2003'), INDEX)).toBe(false);
    expect(isUniqueViolationOn(new Error('P2002'), INDEX)).toBe(false);
  });
});

describe('isLockTimeout', () => {
  it('is true for P2028 whose meta carries SQLSTATE 57014', () => {
    expect(isLockTimeout(known('P2028', { code: '57014' }))).toBe(true);
  });

  it('is true for P2010 raised by a lock_timeout', () => {
    expect(
      isLockTimeout(
        known('P2010', {}, 'Raw query failed: canceling statement due to lock timeout'),
      ),
    ).toBe(true);
  });

  it('is true for a bare error mentioning 57014', () => {
    expect(isLockTimeout(new Error('ERROR: 57014: canceling statement'))).toBe(
      true,
    );
  });

  it('is false for an unrelated known error', () => {
    expect(isLockTimeout(known('P2002', { target: ['x'] }))).toBe(false);
    expect(isLockTimeout(new Error('boom'))).toBe(false);
  });
});
