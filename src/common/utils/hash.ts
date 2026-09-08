import { createHash } from 'node:crypto';

// Canonical JSON with an explicit, fixed field order — not `JSON.stringify` of
// the raw object, so key order in the request body can't change the hash
// (LLD §4.1).
export function canonicalBookingJson(input: {
  parentId?: unknown;
  childId?: unknown;
  classId?: unknown;
  simulatePayment?: unknown;
}): string {
  return JSON.stringify({
    parentId: input.parentId ?? null,
    childId: input.childId ?? null,
    classId: input.classId ?? null,
    simulatePayment: input.simulatePayment ?? null,
  });
}

export function bodyHash(input: {
  parentId?: unknown;
  childId?: unknown;
  classId?: unknown;
  simulatePayment?: unknown;
}): string {
  return createHash('sha256').update(canonicalBookingJson(input)).digest('hex');
}
