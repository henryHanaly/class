// Thin client for the Trial Booking API. One function per endpoint the UI needs.
// Error envelope (all 4xx/5xx): { error, message, requestId } — see FRONTEND-HANDOFF §3.

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '/api';

export type Child = { id: string; name: string; grade: string | null };

export type ParentLookup = {
  parentId: string;
  name: string;
  children: Child[];
};

export type TrialClass = {
  id: string;
  subject: string;
  startsAt: string;
  capacity: number;
  seatsLeft: number;
  priceCents: number;
};

export type RosterStudent = {
  childId: string;
  name: string;
  grade: string | null;
  bookedAt: string;
};

export type Roster = {
  classId: string;
  subject: string;
  students: RosterStudent[];
};

export type SimulatePayment = 'success' | 'fail';

export type BookingResult = {
  bookingId: string;
  status: 'confirmed' | 'payment_failed';
  priceCents: number;
  payment: { result: 'success' | 'fail' };
};

// The API stores price in minor units under one implied currency (see HLD §3).
export const formatPrice = (cents: number): string =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  );

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the API. Is it running on :3000?');
  }

  const body = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) {
    const code = (body?.error as string) ?? `HTTP_${res.status}`;
    const message = (body?.message as string) ?? res.statusText;
    throw new ApiError(res.status, code, message, body?.requestId);
  }
  return body as T;
}

export const api = {
  lookupParent: (email: string) =>
    request<ParentLookup>('/parents/lookup', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  listClasses: () => request<TrialClass[]>('/trial-classes'),

  roster: (classId: string) => request<Roster>(`/trial-classes/${classId}/roster`),

  book: (
    input: { parentId: string; childId: string; classId: string; simulatePayment: SimulatePayment },
    idempotencyKey: string,
  ) =>
    request<BookingResult>('/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      // Send only the fields the API's DTO allows — it rejects unknown keys (422).
      body: JSON.stringify({
        parentId: input.parentId,
        childId: input.childId,
        classId: input.classId,
        simulatePayment: input.simulatePayment,
      }),
    }),
};

export const newIdempotencyKey = (): string => crypto.randomUUID();
