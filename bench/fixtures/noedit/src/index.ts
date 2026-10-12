import { getJson } from "./client";
export async function loadConfig(fetchImpl: Parameters<typeof getJson>[1]) {
  return getJson("https://example.invalid/config.json", fetchImpl);
}
