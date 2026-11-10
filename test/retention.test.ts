import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../apps/api/src/memory";
import type { Message } from "@geohash-chat/shared";
let seq = 0;
function message(room: string): Message {
  const i = seq++;
  return {
    id: randomUUID(),
    room,
    authorId: `guest:${i}`,
    name: "Test",
    text: "Retained content",
    createdAt: new Date(1700000000000 + i).toISOString(),
  };
}
async function all(store: MemoryStore, room: string) {
  let cursor: string | undefined;
  const result: Message[] = [];
  do {
    const page = await store.list(room, cursor);
    result.push(...page.messages);
    cursor = page.cursor;
  } while (cursor);
  return result;
}
afterEach(() => vi.useRealTimers());
describe("independent newest-1000 feeds", () => {
  it("evicts a busy parent independently, preserves inactive children, and does not resurrect on deletion", async () => {
    const store = new MemoryStore();
    const old = message("9q8yy");
    await store.post(old, old.id, old.id);
    for (let i = 0; i < 1000; i++) {
      const m = message("9q9");
      await store.post(m, m.id, m.id);
    }
    expect(await all(store, "9")).toHaveLength(1000);
    expect((await all(store, "9")).some((m) => m.id === old.id)).toBe(false);
    expect((await store.list("9q8yy")).messages[0].id).toBe(old.id);
    await store.remove(old);
    expect((await all(store, "9")).some((m) => m.id === old.id)).toBe(false);
    expect((await store.list("9q8yy")).messages[0].deleted).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 365 * 86400000);
    expect((await store.list("9q8yy")).messages).toHaveLength(1);
  });
  it("drops canonical content after its last copy and does not resurrect on retry", async () => {
    const store = new MemoryStore();
    const first = message("9");
    await store.post(first, first.id, first.id);
    for (let i = 0; i < 1000; i++) {
      const m = message("9");
      await store.post(m, m.id, m.id);
    }
    expect(await store.get(first.id)).toBeUndefined();
    await expect(store.post(first, first.id, first.id)).rejects.toMatchObject({
      status: 410,
    });
    expect(await all(store, "9")).toHaveLength(1000);
  });
  it("keeps the newest keys even when a delayed write arrives out of order", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 1000; i++) {
      const m = message("9");
      await store.post(m, m.id, m.id);
    }
    const delayed = { ...message("9"), createdAt: "2000-01-01T00:00:00.000Z" };
    await store.post(delayed, delayed.id, delayed.id);
    expect(await all(store, "9")).toHaveLength(1000);
    expect(await store.get(delayed.id)).toBeUndefined();
  });
});
