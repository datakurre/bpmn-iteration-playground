import { describe, it, expect } from "vitest";
import { nextReconnectDelay, createBackoffScheduler } from "./websocket";

describe("nextReconnectDelay", () => {
  it("grows by the given factor", () => {
    expect(nextReconnectDelay(1000, 30000)).toBe(1500);
    expect(nextReconnectDelay(1500, 30000)).toBe(2250);
  });

  it("caps at the max", () => {
    expect(nextReconnectDelay(29000, 30000)).toBe(30000);
    expect(nextReconnectDelay(100000, 30000)).toBe(30000);
  });

  it("supports a custom factor", () => {
    expect(nextReconnectDelay(1000, 30000, 2)).toBe(2000);
  });
});

describe("createBackoffScheduler", () => {
  it("starts at the initial delay", () => {
    const scheduler = createBackoffScheduler(1000, 30000);
    expect(scheduler.delay).toBe(1000);
  });

  it("grows the delay on each grow() call, capped at max", () => {
    const scheduler = createBackoffScheduler(1000, 3000);
    scheduler.grow();
    expect(scheduler.delay).toBe(1500);
    scheduler.grow();
    expect(scheduler.delay).toBe(2250);
    scheduler.grow();
    expect(scheduler.delay).toBe(3000);
    scheduler.grow();
    expect(scheduler.delay).toBe(3000);
  });

  it("resets back to the initial delay", () => {
    const scheduler = createBackoffScheduler(1000, 30000);
    scheduler.grow();
    scheduler.grow();
    expect(scheduler.delay).not.toBe(1000);
    scheduler.reset();
    expect(scheduler.delay).toBe(1000);
  });
});
