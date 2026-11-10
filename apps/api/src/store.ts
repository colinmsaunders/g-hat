import type { Identity, Message, Page } from "@geohash-chat/shared";
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
export interface Report {
  id: string;
  messageId: string;
  room: string;
  reason: string;
  reporterId: string;
  createdAt: string;
}
export interface Store {
  guest(tokenHash: string, session: Session, ip: string): Promise<void>;
  session(tokenHash: string): Promise<Session | undefined>;
  rename(tokenHash: string, name: string): Promise<void>;
  list(room: string, cursor?: string): Promise<Page>;
  post(message: Message, requestId: string, ip: string): Promise<Message>;
  get(id: string): Promise<Message | undefined>;
  remove(message: Message): Promise<void>;
  report(report: Report): Promise<void>;
  reports(cursor?: string): Promise<{ reports: Report[]; cursor?: string }>;
  ban(id: string, banned: boolean): Promise<void>;
  counts(rooms: string[]): Promise<Record<string, number>>;
}
export const digestKey = (room: string, m: Message) => ({
  pk: `ROOM#${room}`,
  sk: `MSG#${m.createdAt}#${m.id}`,
});
export const bucket = (time = Date.now()) => Math.floor(time / 300000);
export function cursorEncode(key: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}
export function cursorDecode(
  value: string | undefined,
  pk: string,
): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 1000) throw Error();
    const key = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      key.pk !== pk ||
      typeof key.sk !== "string" ||
      !key.sk.startsWith(pk === "REPORTS" ? "REPORT#" : "MSG#") ||
      Object.keys(key).length !== 2
    )
      throw Error();
    return key;
  } catch {
    throw new ApiError(400, "Invalid pagination cursor.");
  }
}

/** Sort keys preserve timestamp + UUID ordering without storing message bodies in feed metadata. */
export function feedPlan(keys: string[], key: string, capacity = 1000) {
  const ordered = [...new Set([...keys, key])].sort();
  return {
    kept: ordered.slice(-capacity),
    evicted: ordered.slice(0, Math.max(0, ordered.length - capacity)),
  };
}
