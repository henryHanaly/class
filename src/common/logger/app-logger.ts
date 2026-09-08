// Thin structured-logging seam. Console impl today; an APM exporter later is a
// new implementation of the same interface, no call sites change (HLD §13).
export abstract class AppLogger {
  abstract info(event: string, context: Record<string, unknown>): void;
  abstract warn(event: string, context: Record<string, unknown>): void;
  abstract error(event: string, context: Record<string, unknown>): void;
  abstract debug(event: string, context: Record<string, unknown>): void;
}
