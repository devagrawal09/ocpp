import { test, expect } from "bun:test";
import { getJson } from "./client";
test("returns json on ok", async () => {
  const r = await getJson("u", async () => ({ ok: true, status: 200, json: async () => ({ a: 1 }) }));
  expect(r).toEqual({ a: 1 });
});
test("retries then throws", async () => {
  let n = 0;
  await expect(getJson("u", async () => { n++; return { ok: false, status: 500, json: async () => null }; }, 3)).rejects.toThrow();
  expect(n).toBe(3);
});
