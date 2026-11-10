import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { postingRoom } from "@geohash-chat/shared";
import { locationFor } from "./location-fixture";
import { createApp } from "../apps/api/src/app";
import { MemoryStore } from "../apps/api/src/memory";
import { freshPostingLocation } from "../apps/web/src/location";
afterEach(() => vi.unstubAllGlobals());
describe("location-derived posting", () => {
  it("adapts precision for accuracy and latitude", () => {
    for (const room of ["9q8yy", "9q8yyk", "9q8yyk8", "9q8yyk8y", "u4pruy"])
      expect(postingRoom(locationFor(room))).toBe(room);
    const l = locationFor("9q8yyk8y");
    expect(postingRoom({ ...l, accuracy: 1000 }).length).toBeLessThan(
      postingRoom(l).length,
    );
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
  it("ignores requested posting destinations and never stores raw coordinates", async () => {
    const store = new MemoryStore();
    const app = createApp(store);
    const request = async (path: string, body: unknown, token?: string) =>
      app({
        method: "POST",
        path,
        body: JSON.stringify(body),
        query: new URLSearchParams(),
        ip: "x",
        token,
      });
    const session = (await request("/api/sessions", { name: "Guest" }))
      .body as any;
    const body = {
      text: "From here",
      requestId: randomUUID(),
      room: "dr5ru",
      geohash: "dr5ru",
      location: locationFor("9q8yy"),
    };
    const result = await request("/api/messages", body, session.token);
    expect(result.status).toBe(201);
    expect((result.body as any).room).toBe("9q8yy");
    expect((await store.list("dr5ru")).messages).toHaveLength(0);
    expect(JSON.stringify([...store.messages.values()])).not.toMatch(
      /latitude|longitude|accuracy|timestamp/,
    );
    expect(
      (await request("/api/rooms/dr5ru/messages", body, session.token)).status,
    ).toBe(404);
    expect(
      (
        await request(
          "/api/messages",
          { text: "Missing location", requestId: randomUUID() },
          session.token,
        )
      ).status,
    ).toBe(400);
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
