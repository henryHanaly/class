// Pure (HLD §9): seats remaining, never negative, never above capacity.
export function seatsLeft(capacity: number, confirmed: number): number {
  return Math.max(0, capacity - confirmed);
}
