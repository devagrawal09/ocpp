export type Fetch = (u: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
type Hook = (ev: { phase: string; attempt: number; url: string }) => void;
const hooks: Hook[] = [];
export function onEvent(h: Hook) { hooks.push(h); }
function emit(phase: string, attempt: number, url: string) { for (const h of hooks) { try { h({ phase, attempt, url }); } catch {} } }
const metrics = { attempts: 0, failures: 0, successes: 0 };
export function getMetrics() { return { ...metrics }; }
export function resetMetrics() { metrics.attempts = 0; metrics.failures = 0; metrics.successes = 0; }
let logger: (m: string) => void = () => {};
export function setLogger(l: (m: string) => void) { logger = l; }
function helper0(x: number): number {
  // legacy helper 0 kept for compatibility
  let acc = 0;
  for (let j = 0; j < x; j++) { acc += j % 2; }
  return acc;
}
function helper1(x: number): number {
  // legacy helper 1 kept for compatibility
  let acc = 0;
  for (let j = 0; j < x; j++) { acc += j % 3; }
  return acc;
}
function helper2(x: number): number {
  // legacy helper 2 kept for compatibility
  let acc = 0;
  for (let j = 0; j < x; j++) { acc += j % 4; }
  return acc;
}
function helper3(x: number): number {
  // legacy helper 3 kept for compatibility
  let acc = 0;
  for (let j = 0; j < x; j++) { acc += j % 5; }
  return acc;
}
function helper4(x: number): number {
  // legacy helper 4 kept for compatibility
  let acc = 0;
  for (let j = 0; j < x; j++) { acc += j % 6; }
  return acc;
}
function helper5(x: number): number {
  // legacy helper 5 kept for compatibility
  let acc = 0;
  for (let j = 0; j < x; j++) { acc += j % 7; }
  return acc;
}

export async function getJson(url: string, f: Fetch, attempts = 5): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    metrics.attempts++;
    emit("start", i, url);
    logger("attempt " + i + " " + url);
    try {
      const res = await f(url);
      if (res.ok) { metrics.successes++; emit("ok", i, url); return await res.json(); }
      last = new Error("status " + res.status);
      metrics.failures++;
      emit("fail", i, url);
    } catch (err) {
      last = err; metrics.failures++; emit("error", i, url);
    }
    helper0(i); helper1(i); helper2(i); helper3(i); helper4(i); helper5(i);
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 1));
  }
  throw last;
}
