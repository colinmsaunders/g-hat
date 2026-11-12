import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { postingRoom } from "@geohash-chat/shared";
import { locationFor } from "./location-fixture";
import { createApp } from "../apps/api/src/app";
import { MemoryStore } from "../apps/api/src/memory";
import { freshPostingLocation } from "../apps/web/src/location";
afterEach(() => vi.unstubAllGlobals());
describe("location-derived posting", () => {
  it("always derives precision eight regardless of accepted accuracy", () => {
    const l = locationFor("9q8yyk8y");
    expect(postingRoom(l)).toBe("9q8yyk8y");
    expect(postingRoom({ ...l, accuracy: 1000 })).toBe("9q8yyk8y");
  });
  it("rejects stale, future, nonfinite, out-of-range and poor fixes", () => {
    const l = locationFor("9q8yy");
    for (const patch of [
      { timestamp: Date.now() - 60001 },
      { timestamp: Date.now() + 10000 },
      { accuracy: 0 },
      { accuracy: 5001 },
      { latitude: 91 },
      { longitude: 181 },
      { latitude: NaN },
      { accuracy: Infinity },
    ])
      expect(() => postingRoom({ ...l, ...patch })).toThrow();
  });
  it("requests a fresh high-accuracy fix and handles denied permission", async () => {
    const getCurrentPosition = vi.fn(
      (success: any, _error: any, _options: any) =>
        success({
          coords: { latitude: 1, longitude: 2, accuracy: 3 },
          timestamp: 123,
        }),
    );
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    expect(await freshPostingLocation()).toEqual({
      latitude: 1,
      longitude: 2,
      accuracy: 3,
      timestamp: 123,
    });
    expect(getCurrentPosition.mock.calls[0][2]).toEqual({
      maximumAge: 0,
      enableHighAccuracy: true,
      timeout: 15000,
    });
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (_success: any, error: any) => error({ code: 1 }),
      },
    });
    await expect(freshPostingLocation()).rejects.toThrow("permission");
  });
});
