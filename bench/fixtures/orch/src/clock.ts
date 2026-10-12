export function createClock(now: () => number = Date.now) { return { now }; }
