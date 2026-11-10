import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoStore } from "../apps/api/src/dynamo";
import type { Message } from "@geohash-chat/shared";
function msg(i: number): Message {
  return {
    id: randomUUID(),
    room: "9",
    authorId: `guest:${i}`,
    name: "Test",
    text: "A post",
    createdAt: new Date(1700000000000 + i).toISOString(),
  };
}
const key = (item: any) => `${item.pk}/${item.sk}`;
function database() {
  const items = new Map<string, any>();
  let conflicts = 0;
  const transactions: any[][] = [];
  const cancelled = () => {
    conflicts++;
    throw Object.assign(new Error("Conflict"), {
      name: "TransactionCanceledException",
    });
  };
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((async (
    command: any,
  ) => {
    if (command instanceof GetCommand)
      return { Item: structuredClone(items.get(key(command.input.Key))) };
    if (!(command instanceof TransactWriteCommand))
      throw Error("Unsupported test command");
    const writes = command.input.TransactItems!;
    transactions.push(writes);
    const keys = writes.map((w: any) =>
      key(
        w.Put?.Item ?? w.Delete?.Key ?? w.Update?.Key ?? w.ConditionCheck?.Key,
      ),
    );
    expect(new Set(keys).size).toBe(keys.length);
    for (const w of writes) {
      const op = w.Put ?? w.Delete;
      if (!op) continue;
      const current = items.get(key((op as any).Item ?? (op as any).Key));
      if (op.ConditionExpression === "attribute_not_exists(pk)" && current)
        cancelled();
      if (op.ConditionExpression === "attribute_exists(pk)" && !current)
        cancelled();
      if (
        op.ConditionExpression === "revision = :revision" &&
        current?.revision !== op.ExpressionAttributeValues?.[":revision"]
      )
        cancelled();
    }
    for (const w of writes) {
      if (w.Put) items.set(key(w.Put.Item), structuredClone(w.Put.Item));
      if (w.Delete) items.delete(key(w.Delete.Key));
    }
    return {};
  }) as any);
  return { items, transactions, conflicts: () => conflicts };
}
afterEach(() => vi.restoreAllMocks());
describe("DynamoDB bounded retention under contention", () => {
  it("retries a conflicting full-room update and retains exactly the newest 1000", async () => {
    const db = database();
    const existing = Array.from({ length: 1000 }, (_, i) => msg(i));
    const keys = existing.map((m) => `MSG#${m.createdAt}#${m.id}`);
    db.items.set("ROOM#9/FEED", {
      pk: "ROOM#9",
      sk: "FEED",
      keys,
      revision: 1,
    });
    for (const m of existing) {
      db.items.set(`ROOM#9/MSG#${m.createdAt}#${m.id}`, {
        pk: "ROOM#9",
        sk: `MSG#${m.createdAt}#${m.id}`,
        message: m,
      });
      db.items.set(`MESSAGE#${m.id}/META`, {
        pk: `MESSAGE#${m.id}`,
        sk: "META",
        message: m,
        retainedRooms: ["9"],
        revision: 1,
      });
    }
    const store = new DynamoStore("table");
    const a = msg(1001),
      b = msg(1002);
    await Promise.all([store.post(a, a.id, "a"), store.post(b, b.id, "b")]);
    expect(db.conflicts()).toBeGreaterThan(0);
    const retained = db.items.get("ROOM#9/FEED").keys;
    expect(retained).toHaveLength(1000);
    expect(retained).toContain(`MSG#${a.createdAt}#${a.id}`);
    expect(retained).toContain(`MSG#${b.createdAt}#${b.id}`);
    expect(db.items.has(`MESSAGE#${existing[0].id}/META`)).toBe(false);
    expect(db.items.has(`MESSAGE#${existing[1].id}/META`)).toBe(false);
    expect(
      [...db.items.keys()].filter((k) => k.startsWith("ROOM#9/MSG#")),
    ).toHaveLength(1000);
  });
  it("deletes only copies still retained, leaving evicted ancestors absent", async () => {
    const db = database();
    const m = { ...msg(0), room: "9q8yy" };
    db.items.set(`MESSAGE#${m.id}/META`, {
      pk: `MESSAGE#${m.id}`,
      sk: "META",
      message: m,
      retainedRooms: ["9q8yy"],
      revision: 7,
    });
    db.items.set(`ROOM#9q8yy/MSG#${m.createdAt}#${m.id}`, {
      pk: "ROOM#9q8yy",
      sk: `MSG#${m.createdAt}#${m.id}`,
      message: m,
    });
    await new DynamoStore("table").remove(m);
    expect(db.items.has(`ROOM#9/MSG#${m.createdAt}#${m.id}`)).toBe(false);
    expect(db.items.get(`MESSAGE#${m.id}/META`).message.text).toBe("");
    expect(db.transactions[0]).toHaveLength(2);
  });
});
