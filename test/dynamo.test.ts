import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ancestors } from "@geohash-chat/shared";
import { DynamoStore } from "../apps/api/src/dynamo";
const message = {
  id: "e545bb7e-5f05-4c44-b148-278e6b069285",
  room: "9q8yyk8y",
  authorId: "guest:alice",
  name: "Alice",
  text: "A local discovery",
  createdAt: "2026-11-09T12:00:00.000Z",
};
afterEach(() => vi.restoreAllMocks());
describe("DynamoDB write invariants", () => {
  it("uses one atomic transaction for all eight feeds, activity, deduplication and abuse limits", async () => {
    let transaction: any;
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(
      (async (command: any) => {
        if (command instanceof GetCommand) return {};
        if (command instanceof TransactWriteCommand) {
          transaction = command.input;
          return {};
        }
        throw Error("Unexpected command");
      }) as any,
    );
    await new DynamoStore("table").post(message, "request-id", "ip-hash");
    const writes = transaction.TransactItems;
    expect(writes).toHaveLength(29);
    expect(
      writes.filter(
        (w: any) =>
          w.Put?.Item.pk.startsWith("ROOM#") &&
          w.Put?.Item.sk.startsWith("MSG#"),
      ),
    ).toHaveLength(8);
    expect(
      writes.filter((w: any) => w.Update?.Key.pk.startsWith("ACTIVITY#")),
    ).toHaveLength(8);
    expect(writes.filter((w: any) => w.ConditionCheck)).toHaveLength(1);
    expect(
      writes
        .filter((w: any) => w.Update?.Key.pk.startsWith("RATE#"))
        .every((w: any) => Boolean(w.Update.ConditionExpression)),
    ).toBe(true);
    const receipt = writes.find((w: any) =>
      w.Put?.Item.pk.startsWith("REQUEST#"),
    ).Put;
    expect(receipt.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(receipt.Item.messageId).toBe(message.id);
    expect(receipt.Item.message).toBeUndefined();
    const keys = writes.map((w: any) => {
      const item = w.Put?.Item ?? w.Update?.Key ?? w.ConditionCheck?.Key;
      return `${item.pk}/${item.sk}`;
    });
    expect(new Set(keys).size).toBe(29);
  });
  it("atomically removes text from canonical storage and every ancestor", async () => {
    let writes: any[] = [];
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(
      (async (command: any) => {
        if (command instanceof GetCommand)
          return {
            Item: {
              message,
              retainedRooms: ancestors(message.room),
              revision: 1,
            },
          };
        writes = command.input.TransactItems;
        return {};
      }) as any,
    );
    await new DynamoStore("table").remove(message);
    expect(writes).toHaveLength(9);
    for (const w of writes) {
      expect(w.Put.Item.message.text).toBe("");
      expect(w.Put.Item.message.deleted).toBe(true);
    }
  });
  it("returns the winning message after a concurrent duplicate transaction", async () => {
    let attempted = false;
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(
      (async (command: any) => {
        if (command instanceof GetCommand) {
          if (command.input.Key!.pk.startsWith("REQUEST#"))
            return attempted ? { Item: { messageId: message.id } } : {};
          if (command.input.Key!.pk.startsWith("MESSAGE#"))
            return { Item: { message } };
          return {};
        }
        attempted = true;
        throw Object.assign(Error("Transaction cancelled"), {
          name: "TransactionCanceledException",
        });
      }) as any,
    );
    expect(
      await new DynamoStore("table").post(
        { ...message, id: "new-id" },
        "request-id",
        "ip-hash",
      ),
    ).toEqual(message);
  });
});
