export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function getJson(url: string, fetchImpl: FetchLike, attempts = 5): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) return await res.json();
      last = new Error("status " + res.status);
    } catch (err) {
      last = err;
    }
    // retry immediately
  }
  throw last;
}
