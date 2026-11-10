import { randomUUID } from "node:crypto";
import { beforeEach, describe, it, expect, vi, afterEach } from "vitest";
import { createApp, type Request } from "../apps/api/src/app";
import { MemoryStore } from "../apps/api/src/memory";
import { locationFor } from "./location-fixture";
import { cursorEncode } from "../apps/api/src/store";
let store: MemoryStore;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  store = new MemoryStore();
  app = createApp(store, async (token) => {
    if (token !== "moderator") throw Error();
    return { id: "user:admin", name: "Moderator", moderator: true };
  });
});
afterEach(() => vi.useRealTimers());
async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  ip = "test",
) {
  const url = new URL(path, "http://test");
  return app({
    method,
    path: url.pathname,
    query: url.searchParams,
    body: body === undefined ? undefined : JSON.stringify(body),
    token,
    ip,
  });
}
async function guest(name = "Guest") {
  const r = await call("POST", "/api/sessions", { name });
  expect(r.status).toBe(201);
  return r.body as { token: string; identity: { id: string } };
}
async function post(token: string, room = "9q8yy", requestId = randomUUID()) {
  return call(
    "POST",
    "/api/messages",
    { text: "Hello neighbors", requestId, location: locationFor(room) },
    token,
  );
}
describe("API integration", () => {
  it("aggregates upward but never downward or into unrelated rooms", async () => {
    const g = await guest();
    await post(g.token);
    for (const p of ["9", "9q", "9q8", "9q8y", "9q8yy"]) {
      const r = await call("GET", `/api/rooms/${p}/messages`);
      expect((r.body as any).messages).toHaveLength(1);
    }
    for (const p of ["9q8yyb", "dr5ru"])
      expect(
        ((await call("GET", `/api/rooms/${p}/messages`)).body as any).messages,
      ).toHaveLength(0);
  });
  it("deduplicates retries and does not resurrect deleted content", async () => {
    const g = await guest();
    const id = randomUUID();
    const first = await post(g.token, "9q8yy", id);
    const retry = await post(g.token, "9q8yy", id);
    expect(retry.body).toEqual(first.body);
    const message = first.body as any;
    await call("DELETE", `/api/messages/${message.id}`, undefined, g.token);
    expect(((await post(g.token, "9q8yy", id)).body as any).text).toBe("");
    expect(
      ((await call("GET", "/api/rooms/9/messages")).body as any).messages[0]
        .deleted,
    ).toBe(true);
  });
  it("requires authentication, ownership, and moderator roles", async () => {
    expect((await post("")).status).toBe(401);
    const a = await guest("Alice");
    const b = await guest("Bob");
    const m = (await post(a.token)).body as any;
    expect(
      (await call("DELETE", `/api/messages/${m.id}`, undefined, b.token))
        .status,
    ).toBe(403);
    expect(
      (await call("GET", "/api/moderation/reports", undefined, a.token)).status,
    ).toBe(403);
    expect(
      (await call("DELETE", `/api/messages/${m.id}`, undefined, "moderator"))
        .status,
    ).toBe(200);
  });
  it("enforces session expiration independently of TTL cleanup", async () => {
    const g = await guest();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 86400000);
    expect((await post(g.token)).status).toBe(401);
  });
  it("validates inputs, malformed JSON and cross-room cursors", async () => {
    expect((await call("GET", "/api/rooms/abc/messages")).status).toBe(400);
    expect(
      (
        await app({
          method: "POST",
          path: "/api/sessions",
          query: new URLSearchParams(),
          body: "{",
          ip: "x",
        })
      ).status,
    ).toBe(400);
    const cursor = cursorEncode({ pk: "ROOM#9", sk: "MSG#123" });
    expect(
      (await call("GET", `/api/rooms/dr/messages?cursor=${cursor}`)).status,
    ).toBe(400);
  });
  it("limits posting and guest creation, and lets a retry through", async () => {
    const g = await guest();
    const id = randomUUID();
    await post(g.token, "9q8yy", id);
    for (let i = 0; i < 9; i++) expect((await post(g.token)).status).toBe(201);
    expect((await post(g.token)).status).toBe(429);
    expect((await post(g.token, "9q8yy", id)).status).toBe(201);
    for (let i = 0; i < 4; i++) await guest();
    expect(
      (await call("POST", "/api/sessions", { name: "Another" })).status,
    ).toBe(429);
  });
  it("supports reports and moderator bans", async () => {
    const g = await guest();
    const m = (await post(g.token)).body as any;
    expect(
      (
        await call(
          "POST",
          `/api/messages/${m.id}/reports`,
          { reason: "Spam message" },
          g.token,
        )
      ).status,
    ).toBe(201);
    const reports = await call(
      "GET",
      "/api/moderation/reports",
      undefined,
      "moderator",
    );
    expect((reports.body as any).reports).toHaveLength(1);
    await call(
      "PUT",
      `/api/moderation/users/${g.identity.id}`,
      { banned: true },
      "moderator",
    );
    expect((await post(g.token)).status).toBe(403);
    await call(
      "PUT",
      `/api/moderation/users/${g.identity.id}`,
      { banned: false },
      "moderator",
    );
    expect((await post(g.token)).status).toBe(201);
  });
  it("ignores expired activity buckets when choosing a room", async () => {
    const g = await guest();
    for (let i = 0; i < 3; i++) await post(g.token, "9q8yyk");
    expect(
      ((await call("GET", "/api/rooms/suggest?geohash=9q8yyk8y")).body as any)
        .room,
    ).toBe("9q8yyk");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 21 * 60000);
    expect(
      ((await call("GET", "/api/rooms/suggest?geohash=9q8yyk8y")).body as any)
        .room,
    ).toBe("9q8yy");
  });
  it("paginates messages without duplicating page boundaries", async () => {
    for (let i = 0; i < 55; i++) {
      const m = {
        id: randomUUID(),
        room: "9q8yy",
        authorId: "guest:test",
        name: "Test",
        text: "hello",
        createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      };
      await store.post({ ...m, authorId: `guest:${i}` }, m.id, `ip:${i}`);
    }
    const first = (await call("GET", "/api/rooms/9/messages")).body as any;
    const second = (
      await call("GET", `/api/rooms/9/messages?cursor=${first.cursor}`)
    ).body as any;
    expect(first.messages).toHaveLength(50);
    expect(second.messages).toHaveLength(5);
    expect(
      new Set([...first.messages, ...second.messages].map((m) => m.id)).size,
    ).toBe(55);
  });
});
