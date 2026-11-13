import { expect, it, vi, afterEach } from "vitest";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoStore } from "../apps/api/src/dynamo";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("bounds unprocessed-write retries and reports partial publication without rollback", async () => {
  vi.useFakeTimers();
  const send = vi
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockImplementation((async (c: any) => {
      if (c instanceof PutCommand) return {};
      expect(c).toBeInstanceOf(BatchWriteCommand);
      return { UnprocessedItems: c.input.RequestItems };
    }) as any);
  const pending = new DynamoStore("posts", "controls", "archive").post({
    postId: "A".repeat(32),
    originGeohash: "c23nb62w",
    content: "Hi",
    authorId: "guest:a",
    displayName: "A",
    createdAt: new Date().toISOString(),
  });
  const check = expect(pending).rejects.toThrow("incomplete");
  await vi.runAllTimersAsync();
  await check;
  expect(send).toHaveBeenCalledTimes(8);
});
