export async function getJson(url: string, f: (u: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const r = await f(url); if (r.ok) return r.json();
    if (i < attempts - 1) await new Promise(res => setTimeout(res, 250 * 2 ** i));
  }
  throw new Error("failed");
}
