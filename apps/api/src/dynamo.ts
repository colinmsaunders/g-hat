import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
  type BatchWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  ROOM_CAPACITY,
  ancestors,
  originSchema,
  postIdSchema,
  postSlot,
  type Post,
} from "@geochalk/shared";
import {
  ApiError,
  OBSERVATION_TTL_SECONDS,
  cursorEncode,
  reportCursor,
  pagePosts,
  slotKey,
  type Store,
  type Session,
  type Observation,
  type Report,
} from "./store";
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ maxAttempts: 3 }),
  { marshallOptions: { removeUndefinedValues: true } },
);
type Writes = NonNullable<BatchWriteCommandInput["RequestItems"]>[string];
export class DynamoStore implements Store {
  constructor(
    private postsTable: string,
    private controlTable: string,
    private archiveTable: string,
  ) {}
  private async readControl(pk: string, sk = "META") {
    return (
      await client.send(
        new GetCommand({
          TableName: this.controlTable,
          Key: { pk, sk },
          ConsistentRead: true,
        }),
      )
    ).Item;
  }
  async rate(scope: string, limit: number, now: number) {
    const result = await client.send(
      new UpdateCommand({
        TableName: this.controlTable,
        Key: { pk: `RATE#${scope}#${Math.floor(now / 60000)}`, sk: "META" },
        UpdateExpression: "SET expiresAt = :ttl ADD #n :one",
        ExpressionAttributeNames: { "#n": "count" },
        ExpressionAttributeValues: {
          ":ttl": Math.floor(now / 1000) + 120,
          ":one": 1,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    if ((result.Attributes?.count ?? Infinity) > limit)
      throw new ApiError(429, "Slow down and try again in a minute.");
  }
  async guest(tokenHash: string, session: Session, ip: string) {
    await this.rate(`guest:${ip}`, 5, Date.now());
    await client.send(
      new PutCommand({
        TableName: this.controlTable,
        Item: { pk: `SESSION#${tokenHash}`, sk: "META", ...session },
      }),
    );
  }
  async session(tokenHash: string): Promise<Session | undefined> {
    const record = await this.readControl(`SESSION#${tokenHash}`);
    return record
      ? { identity: record.identity, expiresAt: record.expiresAt }
      : undefined;
  }
  async rename(tokenHash: string, name: string) {
    const session = await this.session(tokenHash);
    if (!session || session.expiresAt <= Date.now() / 1000)
      throw new ApiError(401, "Guest session expired.");
    await client.send(
      new PutCommand({
        TableName: this.controlTable,
        Item: {
          pk: `SESSION#${tokenHash}`,
          sk: "META",
          ...session,
          identity: { ...session.identity, name },
        },
      }),
    );
  }
  async observations(actor: string, now: number): Promise<Observation[]> {
    const r = await this.readControl(`OBS#${actor}`);
    return r && r.expiresAt > now / 1000 ? r.observations : [];
  }
  async observe(actor: string, observations: Observation[], now: number) {
    await client.send(
      new PutCommand({
        TableName: this.controlTable,
        Item: {
          pk: `OBS#${actor}`,
          sk: "META",
          observations: observations.slice(-3),
          expiresAt: Math.floor(now / 1000) + OBSERVATION_TTL_SECONDS,
        },
      }),
    );
  }
  async isBanned(actor: string) {
    return (await this.readControl(`USER#${actor}`))?.banned === true;
  }
  async ban(actor: string, banned: boolean) {
    await client.send(
      new PutCommand({
        TableName: this.controlTable,
        Item: { pk: `USER#${actor}`, sk: "META", banned },
      }),
    );
  }
  private async batch(table: string, writes: Writes) {
    let pending = writes;
    for (let attempt = 0; attempt < 7; attempt++) {
      const out = await client.send(
        new BatchWriteCommand({ RequestItems: { [table]: pending } }),
      );
      pending = out.UnprocessedItems?.[table] ?? [];
      if (!pending.length) return;
      if (attempt < 6)
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(1000, 25 * 2 ** attempt) + Math.floor(Math.random() * 25),
          ),
        );
    }
    throw new ApiError(
      503,
      "Publication or moderation is incomplete; some copies may remain. Refresh before retrying.",
    );
  }
  async post(post: Post) {
    originSchema.parse(post.originGeohash);
    postIdSchema.parse(post.postId);
    // Persist the immutable original before publishing any room copies.
    try {
      await client.send(
        new PutCommand({
          TableName: this.archiveTable,
          Item: { ...post },
          ConditionExpression: "attribute_not_exists(postId)",
        }),
      );
    } catch (error) {
      if ((error as Error).name !== "ConditionalCheckFailedException")
        throw error;
      const existing = await this.get(post.originGeohash, post.postId);
      if (
        !existing ||
        Object.keys(post).some(
          (key) => existing[key as keyof Post] !== post[key as keyof Post],
        )
      )
        throw new ApiError(409, "Post ID already exists.");
    }
    // Exactly nine independent unconditional full-body puts. Delayed overwrites are intentional.
    await this.batch(
      this.postsTable,
      ancestors(post.originGeohash).map((room) => ({
        PutRequest: { Item: { ...slotKey(room, post.postId), ...post } },
      })),
    );
  }
  private async roomPosts(room: string): Promise<Post[]> {
    const posts: Post[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: this.postsTable,
          KeyConditionExpression: "pk = :room",
          ExpressionAttributeValues: { ":room": room },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      for (const item of result.Items ?? []) {
        const { pk, sk, ...post } = item;
        // Ignore old Base32 slot keys without migrating or deleting their records.
        if (sk === postSlot(post.postId)) posts.push(post as Post);
      }
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return posts;
  }
  private async blocked(room: string) {
    const blocked = new Set<string>();
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: this.controlTable,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": `MOD#${room}` },
          ProjectionExpression: "sk",
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      for (const item of result.Items ?? []) blocked.add(item.sk);
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return blocked;
  }
  async list(room: string, cursor?: string, limit = ROOM_CAPACITY) {
    const posts = await this.roomPosts(room);
    const blocked = await this.blocked(room);
    return pagePosts(posts, blocked, room, cursor, limit);
  }
  async get(originGeohash: string, postId: string) {
    originSchema.parse(originGeohash);
    postIdSchema.parse(postId);
    const { Item } = await client.send(
      new GetCommand({
        TableName: this.archiveTable,
        Key: { postId },
        ConsistentRead: true,
      }),
    );
    return Item?.originGeohash === originGeohash ? (Item as Post) : undefined;
  }

  async remove(post: Post) {
    const rooms = ancestors(originSchema.parse(post.originGeohash));
    // Body-free moderation markers hide a delayed in-flight publication of this exact ID.
    await this.batch(
      this.controlTable,
      rooms.map((room) => ({
        PutRequest: {
          Item: {
            pk: `MOD#${room}`,
            sk: post.postId,
            originGeohash: post.originGeohash,
          },
        },
      })),
    );
    await Promise.all(
      rooms.map(async (room) => {
        try {
          await client.send(
            new DeleteCommand({
              TableName: this.postsTable,
              Key: slotKey(room, post.postId),
              ConditionExpression: "postId = :id",
              ExpressionAttributeValues: { ":id": post.postId },
            }),
          );
        } catch (error) {
          if ((error as Error).name !== "ConditionalCheckFailedException")
            throw error;
        }
      }),
    );
  }
  async report(report: Report) {
    await this.rate(`report:${report.reporterId}`, 5, Date.now());
    await client.send(
      new PutCommand({
        TableName: this.controlTable,
        Item: {
          pk: "REPORTS",
          sk: `REPORT#${report.createdAt}#${report.id}`,
          report,
        },
      }),
    );
  }
  async reports(cursor?: string) {
    const out = await client.send(
      new QueryCommand({
        TableName: this.controlTable,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "REPORTS" },
        ScanIndexForward: false,
        Limit: 50,
        ExclusiveStartKey: reportCursor(cursor),
      }),
    );
    return {
      reports: (out.Items ?? []).map((item) => item.report as Report),
      cursor: out.LastEvaluatedKey
        ? cursorEncode(out.LastEvaluatedKey)
        : undefined,
    };
  }
  async counts(rooms: string[], now = Date.now()) {
    const counts = await Promise.all(
      rooms.map(async (room) => {
        const posts = await this.roomPosts(room);
        const blocked = await this.blocked(room);
        return [
          room,
          posts.filter(
            (post) =>
              Date.parse(post.createdAt) >= now - 15 * 60_000 &&
              !blocked.has(post.postId),
          ).length,
        ] as const;
      }),
    );
    return Object.fromEntries(counts);
  }
}
