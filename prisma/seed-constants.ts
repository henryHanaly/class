// Fixed UUIDs so seed, e2e specs and the frontend demo all agree (LLD §12).
export const IDS = {
  parentAlice: '00000000-0000-4000-8000-000000000001',
  parentBob: '00000000-0000-4000-8000-000000000002',
  parentCarol: '00000000-0000-4000-8000-000000000003', // 3 children, none booked
  childAmy: '00000000-0000-4000-8000-000000000011', // Alice's
  childBen: '00000000-0000-4000-8000-000000000012', // Alice's
  childCleo: '00000000-0000-4000-8000-000000000013', // Bob's
  childDan: '00000000-0000-4000-8000-000000000014', // Bob's
  childEve: '00000000-0000-4000-8000-000000000015', // Carol's — no bookings
  childFinn: '00000000-0000-4000-8000-000000000016', // Carol's — no bookings
  childGwen: '00000000-0000-4000-8000-000000000017', // Carol's — no bookings
  classOpen: '00000000-0000-4000-8000-000000000021', // A: 1 confirmed, 3 free
  classLastSeat: '00000000-0000-4000-8000-000000000022', // B: 3 confirmed, 1 free
  classFull: '00000000-0000-4000-8000-000000000023', // C: 4 confirmed
  classEmpty: '00000000-0000-4000-8000-000000000024', // D: 0 confirmed, 4 free
} as const;

export const EMAILS = {
  alice: 'alice@example.com',
  bob: 'bob@example.com',
  carol: 'carol@example.com',
} as const;
