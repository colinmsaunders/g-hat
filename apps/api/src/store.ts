import { z } from "zod";
import {
  ROOM_CAPACITY,
  postIdSchema,
  postSlot,
  type Identity,
  type Post,
  type Page,
} from "@geochalk/shared";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Session {
  identity: Identity;
  expiresAt: number;
}
export interface Observation {
  geohash: string;
  accuracy: number;
  receivedAt: number;
  contentHash: string;
}
export interface Report {
  id: string;
  postId: string;
  originGeohash: string;
  authorId: string;
  reason: string;
  reporterId: string;
  createdAt: string;
}
export interface Store {
  guest(tokenHash: string, session: Session, ip: string): Promise<void>;
  session(tokenHash: string): Promise<Session | undefined>;
  rename(tokenHash: string, name: string): Promise<void>;
  rate(scope: string, limit: number, now: number): Promise<void>;
  observations(actor: string, now: number): Promise<Observation[]>;
  observe(
    actor: string,
    observations: Observation[],
    now: number,
  ): Promise<void>;
  isBanned(actor: string): Promise<boolean>;
  list(room: string, cursor?: string, limit?: number): Promise<Page>;
  post(post: Post): Promise<void>;
  get(originGeohash: string, postId: string): Promise<Post | undefined>;
  remove(post: Post): Promise<void>;
  report(report: Report): Promise<void>;
  reports(cursor?: string): Promise<{ reports: Report[]; cursor?: string }>;
  ban(id: string, banned: boolean): Promise<void>;
  counts(rooms: string[], now?: number): Promise<Record<string, number>>;
}
export const slotKey = (room: string, postId: string) => ({
  pk: room,
  sk: postSlot(postId),
});
export const OBSERVATION_TTL_SECONDS = 30 * 60;
export function cursorEncode(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeCursor(value: string): unknown {
  try {
    if (value.length > 1000) throw Error();
    return JSON.parse(Buffer.from(value, "base64url").toString());
  } catch {
    throw new ApiError(400, "Invalid pagination cursor.");
  }
}
export function reportCursor(
  value?: string,
): Record<string, string> | undefined {
  if (!value) return;
  const parsed = z
    .object({ pk: z.literal("REPORTS"), sk: z.string().startsWith("REPORT#") })
    .strict()
    .safeParse(decodeCursor(value));
  if (!parsed.success) throw new ApiError(400, "Invalid pagination cursor.");
  return parsed.data;
}
const positionSchema = z
  .object({
    room: z.string(),
    createdAt: z.iso.datetime(),
    postId: postIdSchema,
  })
  .strict();
export function comparePosts(a: Post, b: Post) {
  return a.createdAt === b.createdAt
    ? a.postId > b.postId
      ? -1
      : a.postId === b.postId
        ? 0
        : 1
    : a.createdAt > b.createdAt
      ? -1
      : 1;
}
/** Exhaust slot pagination and filter moderation BEFORE sorting and selecting a recency page. */
export function pagePosts(
  posts: Post[],
  blocked: Set<string>,
  room: string,
  cursor?: string,
  limit = ROOM_CAPACITY,
): Page {
  let before: z.infer<typeof positionSchema> | undefined;
  if (cursor) {
    const parsed = positionSchema.safeParse(decodeCursor(cursor));
    if (!parsed.success || parsed.data.room !== room)
      throw new ApiError(400, "Invalid pagination cursor.");
    before = parsed.data;
  }
  const available = posts
    .filter(
      (p) =>
        !blocked.has(p.postId) &&
        (!before ||
          p.createdAt < before.createdAt ||
          (p.createdAt === before.createdAt && p.postId < before.postId)),
    )
    .sort(comparePosts);
  const selected = available.slice(0, limit);
  const last = selected.at(-1);
  return {
    posts: selected,
    cursor:
      available.length > limit && last
        ? cursorEncode({ room, createdAt: last.createdAt, postId: last.postId })
        : undefined,
  };
}
