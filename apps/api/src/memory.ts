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
  type Store,
  type Session,
  type Observation,
  type Report,
} from "./store";
/** Process-local development store, mirroring independent slot overwrites, not AWS durability. */
export class MemoryStore implements Store {
  archive = new Map<string, Post>();
  sessions = new Map<string, Session>();
  rooms = new Map<string, Map<string, Post>>();
  bans = new Set<string>();
  blocked = new Map<string, Set<string>>();
  history = new Map<
    string,
    { observations: Observation[]; expiresAt: number }
  >();
  rates = new Map<string, number>();
  reportItems = new Map<string, Report>();
  async rate(scope: string, limit: number, now: number) {
    const key = `${scope}#${Math.floor(now / 60000)}`;
    const count = (this.rates.get(key) ?? 0) + 1;
    this.rates.set(key, count);
    if (count > limit)
      throw new ApiError(429, "Slow down and try again in a minute.");
  }
  async guest(token: string, session: Session, ip: string) {
    await this.rate(`guest:${ip}`, 5, Date.now());
    this.sessions.set(token, session);
  }
  async session(token: string) {
    return this.sessions.get(token);
  }
  async rename(token: string, name: string) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now() / 1000)
      throw new ApiError(401, "Guest session expired.");
    session.identity.name = name;
  }
  async observations(actor: string, now: number) {
    const r = this.history.get(actor);
    return r && r.expiresAt > now / 1000 ? r.observations : [];
  }
  async observe(actor: string, observations: Observation[], now: number) {
    this.history.set(actor, {
      observations: observations.slice(-3),
      expiresAt: Math.floor(now / 1000) + OBSERVATION_TTL_SECONDS,
    });
  }
  async isBanned(actor: string) {
    return this.bans.has(actor);
  }
  async ban(actor: string, banned: boolean) {
    if (banned) this.bans.add(actor);
    else this.bans.delete(actor);
  }
  async post(post: Post) {
    originSchema.parse(post.originGeohash);
    postIdSchema.parse(post.postId);
    const existing = this.archive.get(post.postId);
    if (
      existing &&
      Object.keys(post).some(
        (key) => existing[key as keyof Post] !== post[key as keyof Post],
      )
    )
      throw new ApiError(409, "Post ID already exists.");
    if (!existing) this.archive.set(post.postId, { ...post });
    for (const room of ancestors(originSchema.parse(post.originGeohash))) {
      const slots = this.rooms.get(room) ?? new Map<string, Post>();
      slots.set(postSlot(post.postId), { ...post });
      this.rooms.set(room, slots);
    }
  }
  async list(room: string, cursor?: string, limit = ROOM_CAPACITY) {
    return pagePosts(
      [...(this.rooms.get(room)?.values() ?? [])],
      this.blocked.get(room) ?? new Set(),
      room,
      cursor,
      limit,
    );
  }
  async get(origin: string, postId: string) {
    originSchema.parse(origin);
    const post = this.archive.get(postId);
    return post?.originGeohash === origin ? { ...post } : undefined;
  }

  async remove(post: Post) {
    for (const room of ancestors(post.originGeohash)) {
      const blocked = this.blocked.get(room) ?? new Set<string>();
      blocked.add(post.postId);
      this.blocked.set(room, blocked);
      const slots = this.rooms.get(room);
      if (slots?.get(postSlot(post.postId))?.postId === post.postId)
        slots.delete(postSlot(post.postId));
    }
  }
  async report(report: Report) {
    await this.rate(`report:${report.reporterId}`, 5, Date.now());
    this.reportItems.set(report.id, report);
  }
  async reports(cursor?: string) {
    const before = reportCursor(cursor);
    const items = [...this.reportItems.values()]
      .filter((r) => !before || `REPORT#${r.createdAt}#${r.id}` < before.sk)
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
  async counts(rooms: string[], now = Date.now()) {
    return Object.fromEntries(
      rooms.map((room) => [
        room,
        [...(this.rooms.get(room)?.values() ?? [])].filter(
          (post) =>
            Date.parse(post.createdAt) >= now - 15 * 60_000 &&
            !this.blocked.get(room)?.has(post.postId),
        ).length,
      ]),
    );
  }
}
