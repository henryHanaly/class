export function now(): Date {
  return new Date();
}

export function isPast(date: Date): boolean {
  return date.getTime() < Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
