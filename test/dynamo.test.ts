import { afterEach, expect, it, vi } from "vitest";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  QueryCommand,
  DeleteCommand,
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
it("makes eight unconditional denormalized writes and retries only unprocessed items", async () => {
  const calls: any[] = [];
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((async (
    c: any,
  ) => {
    expect(c).toBeInstanceOf(BatchWriteCommand);
    calls.push(c.input);
    return calls.length === 1
      ? { UnprocessedItems: { posts: [c.input.RequestItems.posts[3]] } }
      : {};
  }) as any);
  await new DynamoStore("posts", "control").post(post);
  expect(calls[0].RequestItems.posts).toHaveLength(8);
  expect(calls[1].RequestItems.posts).toEqual([calls[0].RequestItems.posts[3]]);
  for (const [i, w] of calls[0].RequestItems.posts.entries())
    expect(w).toEqual({
      PutRequest: {
        Item: { ...post, pk: post.originGeohash.slice(0, i + 1), sk: "AA" },
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
        Items: [{ ...post, pk: "c", sk: "AA" }],
        LastEvaluatedKey: { pk: "c", sk: "AA" },
      };
    expect(c.input.ExclusiveStartKey).toEqual({ pk: "c", sk: "AA" });
    return {
      Items: [
        {
          ...post,
          postId: "ZZ" + "A".repeat(30),
          createdAt: "2026-11-11T13:00:00.000Z",
        },
        { ...post, postId: "BB" + "A".repeat(30) },
      ],
    };
  }) as any);
  const page = await new DynamoStore("posts", "control").list("c");
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
    expect(c.input.ConditionExpression).toBe("postId = :id");
    expect(c.input.ExpressionAttributeValues[":id"]).toBe(post.postId);
    deletes++;
    throw Object.assign(new Error(), {
      name: "ConditionalCheckFailedException",
    });
  }) as any);
  await new DynamoStore("posts", "control").remove(post);
  expect(deletes).toBe(8);
});
