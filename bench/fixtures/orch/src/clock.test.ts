import { test, expect } from "bun:test";
import { createClock } from "./clock";
test("clock uses injected now", () => { expect(createClock(() => 5).now()).toBe(5); });
