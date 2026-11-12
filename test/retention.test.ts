import { expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encodePostId,
  postSlot,
  ancestors,
  type Post,
} from "@geohash-chat/shared";
import { MemoryStore } from "../apps/api/src/memory";
export const makePost = (overrides: Partial<Post> = {}): Post => ({
  postId: "A".repeat(32),
  originGeohash: "c23nb62w",
  content: "Hello",
  authorId: "guest:alice",
  displayName: "Alice",
  createdAt: "2026-11-11T12:00:00.000Z",
  ...overrides,
});
it("maps all 1024 uniformly represented leading ten-bit patterns to distinct slots", () => {
  const slots = new Map<string, number>();
  for (let value = 0; value < 65536; value++) {
    const bytes = new Uint8Array(20);
    bytes[0] = value >>> 8;
    bytes[1] = value & 255;
    const id = encodePostId(bytes);
    expect(postSlot(id)).toBe(id.slice(0, 2));
    const slot = postSlot(id);
    slots.set(slot, (slots.get(slot) ?? 0) + 1);
  }
  expect(slots.size).toBe(1024);
  expect(new Set(slots.values())).toEqual(new Set([64]));
  expect(encodePostId(new Uint8Array(20).fill(255))).toBe("7".repeat(32));
});
it("cryptographic samples reach all slots with broadly uniform frequency", () => {
  const counts = new Map<string, number>();
  for (let i = 0; i < 65536; i++) {
    const slot = postSlot(encodePostId(randomBytes(20)));
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  expect(counts.size).toBe(1024);
  expect(
    [...counts.values()].reduce((sum, n) => sum + (n - 64) ** 2 / 64, 0),
  ).toBeLessThan(1400);
});
it("copies full posts eight times; shared ancestor collisions do not delete other descendants", async () => {
  const store = new MemoryStore(),
    a = makePost(),
    b = makePost({ postId: "AA" + "B".repeat(30), originGeohash: "c23nb62x" });
  await store.post(a);
  expect([...store.rooms.keys()]).toEqual(ancestors(a.originGeohash));
  for (const slots of store.rooms.values())
    expect([...slots.values()]).toEqual([a]);
  await store.post(b);
  expect((await store.list("c")).posts).toEqual([b]);
  expect((await store.list(a.originGeohash)).posts).toEqual([a]);
  await store.post(a);
  expect((await store.list("c")).posts).toEqual([a]);
});
it("allows delayed older writes, preserves replacements on moderation, hides replayed deleted IDs", async () => {
  const store = new MemoryStore(),
    old = makePost(),
    newer = makePost({
      postId: "AA" + "C".repeat(30),
      createdAt: "2026-11-11T13:00:00.000Z",
    });
  await store.post(newer);
  await store.post(old);
  expect((await store.list("c")).posts).toEqual([old]);
  await store.post(newer);
  await store.remove(old);
  expect((await store.list("c")).posts).toEqual([newer]);
  await store.post(old);
  expect((await store.list("c")).posts).toEqual([]);
});
it("sorts by timestamp and paginates across random slots", async () => {
  const store = new MemoryStore();
  const old = makePost({ postId: "ZZ" + "A".repeat(30) }),
    recent = makePost({
      postId: "AB" + "A".repeat(30),
      createdAt: "2026-11-11T13:00:00.000Z",
    });
  await store.post(old);
  await store.post(recent);
  const page = await store.list("c", undefined, 1);
  expect(page.posts).toEqual([recent]);
  expect((await store.list("c", page.cursor, 1)).posts).toEqual([old]);
  await expect(store.list("d", page.cursor)).rejects.toThrow();
});
it("keeps at most 1024 slots after filling every slot and overwriting them", async () => {
  const store = new MemoryStore();
  for (let i = 0; i < 2048; i++) {
    const bytes = new Uint8Array(20);
    bytes[0] = (i % 1024) >>> 2;
    bytes[1] = (i % 4) << 6;
    bytes[19] = i >= 1024 ? 1 : 0;
    await store.post(makePost({ postId: encodePostId(bytes) }));
  }
  for (const room of store.rooms.values()) expect(room.size).toBe(1024);
});
