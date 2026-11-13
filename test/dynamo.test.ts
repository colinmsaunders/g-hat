import { afterEach, expect, it, vi } from "vitest";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoStore } from "../apps/api/src/dynamo";
const post = {
  postId: "A".repeat(32),
  originGeohash: "c23nb62w",
  content: "Hello",
  authorId: "guest:a",
  displayName: "A",
  createdAt: "2026-11-11T12:00:00.000Z",
};
afterEach(() => vi.restoreAllMocks());
it("makes nine unconditional denormalized writes and retries only unprocessed items", async () => {
  const calls: any[] = [];
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((async (
    c: any,
  ) => {
    if (c instanceof PutCommand) {
      expect(c.input).toEqual({
        TableName: "archive",
        Item: post,
        ConditionExpression: "attribute_not_exists(postId)",
      });
      expect(calls).toHaveLength(0);
      return {};
    }
    expect(c).toBeInstanceOf(BatchWriteCommand);
    calls.push(c.input);
    return calls.length === 1
      ? { UnprocessedItems: { posts: [c.input.RequestItems.posts[3]] } }
      : {};
  }) as any);
  await new DynamoStore("posts", "control", "archive").post(post);
  expect(calls[0].RequestItems.posts).toHaveLength(9);
  expect(calls[1].RequestItems.posts).toEqual([calls[0].RequestItems.posts[3]]);
  for (const [i, w] of calls[0].RequestItems.posts.entries())
    expect(w).toEqual({
      PutRequest: {
        Item: {
          ...post,
          pk: i === 0 ? "_" : post.originGeohash.slice(0, i),
          sk: "00",
        },
      },
    });
});
it("reads every DynamoDB page, filters moderation and sorts timestamps rather than slots", async () => {
  let pages = 0;
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((async (
    c: any,
  ) => {
    expect(c).toBeInstanceOf(QueryCommand);
    if (c.input.TableName === "control")
      return { Items: [{ sk: "BB" + "A".repeat(30) }] };
    pages++;
    if (pages === 1)
      return {
        Items: [
          { ...post, pk: "c", sk: "00" },
          { ...post, pk: "c", sk: "AA" },
        ],
        LastEvaluatedKey: { pk: "c", sk: "00" },
      };
    expect(c.input.ExclusiveStartKey).toEqual({ pk: "c", sk: "00" });
    return {
      Items: [
        {
          ...post,
          sk: "ce",
          postId: "ZZ" + "A".repeat(30),
          createdAt: "2026-11-11T13:00:00.000Z",
        },
        { ...post, sk: "08", postId: "BB" + "A".repeat(30) },
      ],
    };
  }) as any);
  const page = await new DynamoStore("posts", "control", "archive").list("c");
  expect(pages).toBe(2);
  expect(page.posts.map((p) => p.postId.slice(0, 2))).toEqual(["ZZ", "AA"]);
});
it("guards moderation deletes by exact post ID and tolerates replaced slots", async () => {
  let deletes = 0;
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((async (
    c: any,
  ) => {
    if (c instanceof BatchWriteCommand) return {};
    expect(c).toBeInstanceOf(DeleteCommand);
    expect(c.input.TableName).toBe("posts");
    expect(c.input.ConditionExpression).toBe("postId = :id");
    expect(c.input.ExpressionAttributeValues[":id"]).toBe(post.postId);
    deletes++;
    throw Object.assign(new Error(), {
      name: "ConditionalCheckFailedException",
    });
  }) as any);
  await new DynamoStore("posts", "control", "archive").remove(post);
  expect(deletes).toBe(9);
});

it("does not publish room copies if the archive insert fails", async () => {
  const send = vi
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockRejectedValue(new Error("archive unavailable") as never);
  await expect(
    new DynamoStore("posts", "control", "archive").post(post),
  ).rejects.toThrow("archive unavailable");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBeInstanceOf(PutCommand);
});
it("reuses identical archive records but rejects an attempt to overwrite a post ID", async () => {
  const send = vi
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockImplementation((async (c: any) => {
      if (c instanceof PutCommand)
        throw Object.assign(new Error(), {
          name: "ConditionalCheckFailedException",
        });
      if (c instanceof GetCommand) {
        expect(c.input).toEqual({
          TableName: "archive",
          Key: { postId: post.postId },
          ConsistentRead: true,
        });
        return { Item: post };
      }
      expect(c).toBeInstanceOf(BatchWriteCommand);
      return {};
    }) as any);
  const store = new DynamoStore("posts", "control", "archive");
  await store.post(post);
  send.mockClear();
  await expect(store.post({ ...post, content: "Changed" })).rejects.toThrow(
    "already exists",
  );
  expect(send).toHaveBeenCalledTimes(2);
  expect(await store.get("u10j46tj", post.postId)).toBeUndefined();
});
