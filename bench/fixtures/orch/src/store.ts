export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export function createStore() {
  const m = new Map<string, unknown>();
  return {
    get(k: string): Result<unknown> { return m.has(k) ? { ok: true, value: m.get(k) } : { ok: false, error: "missing " + k }; },
    set(k: string, v: unknown): Result<void> { m.set(k, v); return { ok: true, value: undefined }; },
  };
}
