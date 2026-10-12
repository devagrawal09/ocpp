export async function getJson(url: string, f: (u: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>, attempts = 3) {
  for (let i = 0; i < attempts; i++) { const r = await f(url); if (r.ok) return r.json(); }
  throw new Error("failed after " + attempts);
}
