import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
  BatchGetCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ROOM_CAPACITY, ancestors, type Message } from "@geohash-chat/shared";
import {
  ApiError,
  bucket,
  cursorDecode,
  cursorEncode,
  digestKey,
  feedPlan,
  type Report,
  type Session,
  type Store,
} from "./store";
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
export class DynamoStore implements Store {
  constructor(private table: string) {}
  async read(pk: string, sk = "META") {
    return (
      await client.send(
        new GetCommand({
          TableName: this.table,
          Key: { pk, sk },
          ConsistentRead: true,
        }),
      )
    ).Item;
  }
  rate(key: string, max: number): Write {
    return {
      Update: {
        TableName: this.table,
        Key: {
          pk: `RATE#${key}#${Math.floor(Date.now() / 60000)}`,
          sk: "META",
        },
        UpdateExpression: "SET expiresAt = :ttl ADD #n :one",
        ConditionExpression: "attribute_not_exists(#n) OR #n < :max",
        ExpressionAttributeNames: { "#n": "count" },
        ExpressionAttributeValues: {
          ":ttl": Math.floor(Date.now() / 1000) + 120,
          ":one": 1,
          ":max": max,
        },
      },
    };
  }
  async transaction(items: Write[]) {
    await client.send(new TransactWriteCommand({ TransactItems: items }));
  }
  async guest(token: string, session: Session, ip: string) {
    try {
      await this.transaction([
        this.rate(`guest#${ip}`, 5),
        {
          Put: {
            TableName: this.table,
            Item: { pk: `SESSION#${token}`, sk: "META", ...session },
          },
        },
      ]);
    } catch (e) {
      if ((e as Error).name === "TransactionCanceledException")
        throw new ApiError(
          429,
          "Too many guest sessions. Try again in a minute.",
        );
      throw e;
    }
  }
  async session(token: string) {
    const item = await this.read(`SESSION#${token}`);
    return item
      ? ({ identity: item.identity, expiresAt: item.expiresAt } as Session)
      : undefined;
  }
  async rename(token: string, name: string) {
    await client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `SESSION#${token}`, sk: "META" },
        UpdateExpression: "SET #identity.#name = :name",
        ConditionExpression: "attribute_exists(pk) AND expiresAt > :now",
        ExpressionAttributeNames: { "#identity": "identity", "#name": "name" },
        ExpressionAttributeValues: {
          ":name": name,
          ":now": Math.floor(Date.now() / 1000),
        },
      }),
    );
  }
  async list(room: string, cursor?: string) {
    const out = await client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `ROOM#${room}`, ":prefix": "MSG#" },
        ScanIndexForward: false,
        ConsistentRead: true,
        Limit: 50,
        ExclusiveStartKey: cursorDecode(cursor, `ROOM#${room}`),
      }),
    );
    return {
      messages: (out.Items ?? []).map((i) => i.message as Message),
      cursor: out.LastEvaluatedKey
        ? cursorEncode(out.LastEvaluatedKey)
        : undefined,
    };
  }
  async replay(id: string) {
    const message = await this.get(id);
    if (!message)
      throw new ApiError(
        410,
        "This post was already accepted and has since been evicted.",
      );
    return message;
  }
  versionCondition(revision: number | undefined) {
    return revision === undefined
      ? { ConditionExpression: "attribute_not_exists(pk)" }
      : {
          ConditionExpression: "revision = :revision",
          ExpressionAttributeValues: { ":revision": revision },
        };
  }
  async post(m: Message, requestId: string, ip: string): Promise<Message> {
    const receipt = `REQUEST#${m.authorId}#${requestId}`;
    const prefixes = ancestors(m.room);
    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = await this.read(receipt);
      if (previous) return this.replay(previous.messageId);
      const states = await Promise.all(
        prefixes.map((p) => this.read(`ROOM#${p}`, "FEED")),
      );
      const plans = prefixes.map((p, i) => ({
        room: p,
        state: states[i],
        ...feedPlan(states[i]?.keys ?? [], digestKey(p, m).sk, ROOM_CAPACITY),
      }));
      const retainedRooms = plans
        .filter((p) => p.kept.includes(digestKey(p.room, m).sk))
        .map((p) => p.room);
      const victims = new Map<string, string[]>();
      for (const plan of plans)
        for (const key of plan.evicted) {
          const id = key.slice(-36);
          if (id !== m.id)
            victims.set(id, [...(victims.get(id) ?? []), plan.room]);
        }
      const records = await Promise.all(
        [...victims.keys()].map(
          async (id) => [id, await this.read(`MESSAGE#${id}`)] as const,
        ),
      );
      // A concurrent eviction may have removed a victim; reload the room revisions.
      if (records.some(([, record]) => !record)) continue;
      const writes: Write[] = [
        {
          ConditionCheck: {
            TableName: this.table,
            Key: { pk: `USER#${m.authorId}`, sk: "META" },
            ConditionExpression:
              "attribute_not_exists(banned) OR banned = :false",
            ExpressionAttributeValues: { ":false": false },
          },
        },
        this.rate(`user#${m.authorId}`, 10),
        this.rate(`ip#${ip}`, 30),
        {
          Put: {
            TableName: this.table,
            Item: {
              pk: receipt,
              sk: "META",
              messageId: m.id,
              expiresAt: Math.floor(Date.now() / 1000) + 86400,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ];
      if (retainedRooms.length)
        writes.push({
          Put: {
            TableName: this.table,
            Item: {
              pk: `MESSAGE#${m.id}`,
              sk: "META",
              message: m,
              retainedRooms,
              revision: 1,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        });
      for (const plan of plans) {
        writes.push({
          Put: {
            TableName: this.table,
            Item: {
              pk: `ROOM#${plan.room}`,
              sk: "FEED",
              keys: plan.kept,
              revision: (plan.state?.revision ?? 0) + 1,
            },
            ...this.versionCondition(plan.state?.revision),
          },
        });
        if (retainedRooms.includes(plan.room))
          writes.push({
            Put: {
              TableName: this.table,
              Item: { ...digestKey(plan.room, m), message: m },
            },
          });
        for (const key of plan.evicted)
          if (key.slice(-36) !== m.id)
            writes.push({
              Delete: {
                TableName: this.table,
                Key: { pk: `ROOM#${plan.room}`, sk: key },
              },
            });
        writes.push({
          Update: {
            TableName: this.table,
            Key: { pk: `ACTIVITY#${plan.room}`, sk: `BUCKET#${bucket()}` },
            UpdateExpression: "SET expiresAt = :ttl ADD #n :one",
            ExpressionAttributeNames: { "#n": "count" },
            ExpressionAttributeValues: {
              ":ttl": (bucket() + 5) * 300,
              ":one": 1,
            },
          },
        });
      }
      for (const [id, record] of records) {
        const remaining = (record!.retainedRooms as string[]).filter(
          (p) => !victims.get(id)!.includes(p),
        );
        const condition = this.versionCondition(record!.revision);
        if (remaining.length)
          writes.push({
            Put: {
              TableName: this.table,
              Item: {
                ...record,
                retainedRooms: remaining,
                revision: record!.revision + 1,
              },
              ...condition,
            },
          });
        else
          writes.push({
            Delete: {
              TableName: this.table,
              Key: { pk: `MESSAGE#${id}`, sk: "META" },
              ...condition,
            },
          });
      }
      try {
        await this.transaction(writes);
        return m;
      } catch (error) {
        if ((error as Error).name !== "TransactionCanceledException")
          throw error;
        const replay = await this.read(receipt);
        if (replay) return this.replay(replay.messageId);
        if ((await this.read(`USER#${m.authorId}`))?.banned)
          throw new ApiError(403, "This identity is banned.");
        if (attempt < 3)
          await new Promise((resolve) =>
            setTimeout(resolve, 25 * 2 ** attempt),
          );
      }
    }
    throw new ApiError(
      429,
      "Posting is busy or rate limited. Retry with the same request ID.",
    );
  }
  async get(id: string) {
    return (await this.read(`MESSAGE#${id}`))?.message as Message | undefined;
  }
  async remove(m: Message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const record = await this.read(`MESSAGE#${m.id}`);
      if (!record) return;
      const deleted = { ...record.message, text: "", deleted: true };
      const writes: Write[] = [
        {
          Put: {
            TableName: this.table,
            Item: {
              ...record,
              message: deleted,
              revision: record.revision + 1,
            },
            ...this.versionCondition(record.revision),
          },
        },
      ];
      for (const room of record.retainedRooms as string[])
        writes.push({
          Put: {
            TableName: this.table,
            Item: { ...digestKey(room, m), message: deleted },
            ConditionExpression: "attribute_exists(pk)",
          },
        });
      try {
        await this.transaction(writes);
        return;
      } catch (error) {
        if ((error as Error).name !== "TransactionCanceledException")
          throw error;
      }
    }
    throw new ApiError(409, "Message changed during deletion. Please retry.");
  }
  async report(report: Report) {
    try {
      await this.transaction([
        this.rate(`report#${report.reporterId}`, 5),
        {
          Put: {
            TableName: this.table,
            Item: {
              pk: "REPORTS",
              sk: `REPORT#${report.createdAt}#${report.id}`,
              report,
            },
          },
        },
      ]);
    } catch (e) {
      if ((e as Error).name === "TransactionCanceledException")
        throw new ApiError(429, "Too many reports. Try again in a minute.");
      throw e;
    }
  }
  async reports(cursor?: string) {
    const out = await client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "REPORTS" },
        ScanIndexForward: false,
        Limit: 50,
        ExclusiveStartKey: cursorDecode(cursor, "REPORTS"),
      }),
    );
    return {
      reports: (out.Items ?? []).map((i) => i.report as Report),
      cursor: out.LastEvaluatedKey
        ? cursorEncode(out.LastEvaluatedKey)
        : undefined,
    };
  }
  async ban(id: string, banned: boolean) {
    await client.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `USER#${id}`, sk: "META", banned },
      }),
    );
  }
  async counts(rooms: string[]) {
    const counts: Record<string, number> = Object.fromEntries(
      rooms.map((p) => [p, 0]),
    );
    let pending = rooms.flatMap((p) =>
      [0, 1, 2, 3].map((i) => ({
        pk: `ACTIVITY#${p}`,
        sk: `BUCKET#${bucket() - i}`,
      })),
    );
    for (let attempt = 0; pending.length && attempt < 4; attempt++) {
      const out = await client.send(
        new BatchGetCommand({
          RequestItems: {
            [this.table]: { Keys: pending, ConsistentRead: true },
          },
        }),
      );
      for (const i of out.Responses?.[this.table] ?? [])
        counts[i.pk.slice(9)] += i.count ?? 0;
      pending = (out.UnprocessedKeys?.[this.table]?.Keys ??
        []) as typeof pending;
      if (pending.length)
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
    if (pending.length)
      throw new ApiError(503, "Activity is temporarily unavailable.");
    return counts;
  }
}
