import { test, expect } from "bun:test";
import { createStore } from "./store";
test("get missing returns error", () => { expect(createStore().get("x").ok).toBe(false); });
