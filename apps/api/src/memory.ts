import {
  ROOM_CAPACITY,
  ancestors,
  type Message,
  type Page,
} from "@geohash-chat/shared";
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
/** Local development only: data lives in this process and resets on restart. */
export class MemoryStore implements Store {
  sessions = new Map<string, Session>();
  messages = new Map<string, Message>();
  feeds = new Map<string, string[]>();
  retainedRooms = new Map<string, Set<string>>();
  bans = new Set<string>();
  receipts = new Map<string, string>();
  reportItems = new Map<string, Report>();
  activity = new Map<string, number>();
  rates = new Map<string, number>();
  rate(key: string, max: number) {
    const n = this.rates.get(key) ?? 0;
    if (n >= max)
      throw new ApiError(429, "Slow down and try again in a minute.");
    this.rates.set(key, n + 1);
  }
  async guest(token: string, session: Session, ip: string) {
    this.rate(`guest#${ip}#${Math.floor(Date.now() / 60000)}`, 5);
    this.sessions.set(token, session);
  }
  async session(token: string) {
    return this.sessions.get(token);
  }
  async rename(token: string, name: string) {
    const s = this.sessions.get(token);
    if (!s) throw new ApiError(401, "Session expired.");
    s.identity.name = name;
  }
  async list(room: string, cursor?: string): Promise<Page> {
    const key = cursorDecode(cursor, `ROOM#${room}`);
    const all = (this.feeds.get(room) ?? [])
      .map((key) => this.messages.get(key.slice(-36))!)
      .filter(Boolean)
      .filter(
        (m) =>
          m.room.startsWith(room) && (!key || digestKey(room, m).sk < key.sk),
      )
      .sort((a, b) =>
        digestKey(room, b).sk.localeCompare(digestKey(room, a).sk),
      );
    const messages = all.slice(0, 50);
    return {
      messages,
      cursor:
        all.length > 50
          ? cursorEncode(digestKey(room, messages.at(-1)!))
          : undefined,
    };
  }
  async post(m: Message, requestId: string, ip: string) {
    const receipt = `${m.authorId}#${requestId}`;
    const existing = this.receipts.get(receipt);
    if (existing) {
      const original = this.messages.get(existing);
      if (!original)
        throw new ApiError(
          410,
          "This post was already accepted and has since been evicted.",
        );
      return original;
    }
    if (this.bans.has(m.authorId))
      throw new ApiError(403, "This identity is banned.");
    const minute = Math.floor(Date.now() / 60000);
    this.rate(`user#${m.authorId}#${minute}`, 10);
    this.rate(`ip#${ip}#${minute}`, 30);
    this.messages.set(m.id, m);
    this.retainedRooms.set(m.id, new Set(ancestors(m.room)));
    this.receipts.set(receipt, m.id);
    for (const p of ancestors(m.room)) {
      const plan = feedPlan(
        this.feeds.get(p) ?? [],
        digestKey(p, m).sk,
        ROOM_CAPACITY,
      );
      this.feeds.set(p, plan.kept);
      for (const key of plan.evicted) {
        const id = key.slice(-36);
        const retained = this.retainedRooms.get(id);
        retained?.delete(p);
        if (!retained?.size) {
          this.messages.delete(id);
          this.retainedRooms.delete(id);
        }
      }
      const key = `${p}#${bucket()}`;
      this.activity.set(key, (this.activity.get(key) ?? 0) + 1);
    }
    return m;
  }
  async get(id: string) {
    return this.messages.get(id);
  }
  async remove(m: Message) {
    if (this.messages.has(m.id))
      this.messages.set(m.id, { ...m, text: "", deleted: true });
  }
  async report(r: Report) {
    this.rate(`report#${r.reporterId}#${Math.floor(Date.now() / 60000)}`, 5);
    this.reportItems.set(r.id, r);
  }
  async reports(cursor?: string) {
    const key = cursorDecode(cursor, "REPORTS");
    const items = [...this.reportItems.values()]
      .filter((r) => !key || `REPORT#${r.createdAt}#${r.id}` < key.sk)
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
    const reports = items.slice(0, 50);
    const last = reports.at(-1);
    return {
      reports,
      cursor:
        items.length > 50 && last
          ? cursorEncode({
              pk: "REPORTS",
              sk: `REPORT#${last.createdAt}#${last.id}`,
            })
          : undefined,
    };
  }
  async ban(id: string, banned: boolean) {
    if (banned) this.bans.add(id);
    else this.bans.delete(id);
  }
  async counts(rooms: string[]) {
    return Object.fromEntries(
      rooms.map((p) => [
        p,
        [0, 1, 2, 3].reduce(
          (n, i) => n + (this.activity.get(`${p}#${bucket() - i}`) ?? 0),
          0,
        ),
      ]),
    );
  }
}
