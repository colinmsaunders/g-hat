import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ancestors,
  chooseRoom,
  nameSchema,
  postSchema,
  postingRoom,
  roomSchema,
  type Identity,
  type Post,
  encodePostId,
  postIdSchema,
  originSchema,
} from "@geohash-chat/shared";
import { ApiError, type Store } from "./store";
import { admitPost, type LocationRiskCheck } from "./admission";
export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  token?: string;
  cookie?: string;
  csrf?: string;
  body?: string;
  ip: string;
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function createApp(
  store: Store,
  verifyUser?: (token: string) => Promise<Identity>,
  options: {
    readOnly?: boolean;
    insecureLocalCookie?: boolean;
    riskCheck?: LocationRiskCheck;
  } = {},
) {
  return async (
    req: Request,
  ): Promise<{ status: number; body: unknown; cookies?: string[] }> => {
    try {
      if (options.readOnly && !["GET", "HEAD", "OPTIONS"].includes(req.method))
        throw new ApiError(
          503,
          "Posting and account changes are temporarily paused for a region migration. Browsing remains available.",
        );
      if ((req.body?.length ?? 0) > 16000)
        throw new ApiError(413, "Request too large.");
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.csrf !== "1")
        throw new ApiError(403, "Missing same-origin request header.");
      const cookieName = options.insecureLocalCookie
        ? "geohash_guest"
        : "__Host-geohash_guest";
      const guestToken = req.cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith(cookieName + "="))
        ?.slice(cookieName.length + 1);
      const parse = () => {
        try {
          return JSON.parse(req.body ?? "{}");
        } catch {
          throw new ApiError(400, "Invalid JSON.");
        }
      };
      const path = req.path.replace(/^\/api/, "").replace(/\/$/, "");
      const ip = hash(req.ip); // Never persist raw source IPs.
      const authenticate = async () => {
        const token = req.token;
        if (!token) {
          const session = guestToken
            ? await store.session(hash(guestToken))
            : undefined;
          if (!session || session.expiresAt <= Date.now() / 1000)
            throw new ApiError(401, "Guest session expired.");
          return session.identity;
        }
        if (verifyUser) {
          try {
            return await verifyUser(token);
          } catch {
            throw new ApiError(401, "Invalid or expired sign-in.");
          }
        }
        throw new ApiError(401, "Invalid session.");
      };
      const moderator = async () => {
        const user = await authenticate();
        if (!user.moderator)
          throw new ApiError(403, "Moderator access required.");
        return user;
      };
      if (req.method === "GET" && path === "/health")
        return { status: 200, body: { ok: true } };
      if (req.method === "POST" && path === "/sessions") {
        const { name } = z
          .object({ name: nameSchema.default("Wanderer") })
          .parse(parse());
        const existing = guestToken
          ? await store.session(hash(guestToken))
          : undefined;
        if (existing && existing.expiresAt > Date.now() / 1000)
          return { status: 200, body: existing };
        const token = randomBytes(32).toString("base64url");
        const identity = {
          id: `guest:${randomUUID()}`,
          name,
          moderator: false,
        };
        const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
        await store.guest(hash(token), { identity, expiresAt }, ip);
        return {
          status: 201,
          body: { identity, expiresAt },
          cookies: [
            `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${options.insecureLocalCookie ? "" : "; Secure"}`,
          ],
        };
      }
      if (req.method === "GET" && path === "/me")
        return { status: 200, body: await authenticate() };
      if (req.method === "PATCH" && path === "/me") {
        const user = await authenticate();
        if (req.token || !guestToken)
          throw new ApiError(
            400,
            "Registered names are managed in your account.",
          );
        const { name } = z.object({ name: nameSchema }).parse(parse());
        await store.rename(hash(guestToken), name);
        return { status: 200, body: { ...user, name } };
      }
      if (req.method === "GET" && path === "/rooms/suggest") {
        const geohash = roomSchema.parse(req.query.get("geohash"));
        const counts = await store.counts(ancestors(geohash));
        return {
          status: 200,
          body: {
            room: chooseRoom(geohash, counts),
            counts,
            windowMinutes: 15,
            targetMessages: 3,
          },
        };
      }
      const roomMatch = path.match(/^\/rooms\/([^/]+)\/messages$/);
      if (roomMatch) {
        const room = roomSchema.parse(roomMatch[1]);
        if (req.method === "GET")
          return {
            status: 200,
            body: await store.list(room, req.query.get("cursor") ?? undefined),
          };
      }
      if (req.method === "POST" && path === "/messages") {
        const user = await authenticate();
        const { content, location } = postSchema.parse(parse());
        let room: string;
        try {
          room = postingRoom(location);
        } catch (error) {
          if (error instanceof z.ZodError) throw error;
          throw new ApiError(400, (error as Error).message);
        }
        await admitPost(
          store,
          user.id,
          req.ip,
          location,
          content,
          Date.now(),
          options.riskCheck,
        );
        const message: Post = {
          postId: encodePostId(randomBytes(20)),
          originGeohash: room,
          authorId: user.id,
          displayName: user.name,
          content,
          createdAt: new Date().toISOString(),
        };
        await store.post(message);
        return { status: 201, body: message };
      }
      const messageMatch = path.match(/^\/messages\/([^/]+)(\/reports)?$/);
      if (messageMatch) {
        const user = await authenticate();
        const id = postIdSchema.parse(messageMatch[1]);
        const origin = originSchema.parse(
          req.query.get("originGeohash") ?? parse()?.originGeohash,
        );
        const message = await store.get(origin, id);
        if (!message) throw new ApiError(404, "Message not found.");
        if (req.method === "DELETE" && !messageMatch[2]) {
          if (message.authorId !== user.id && !user.moderator)
            throw new ApiError(403, "You may only delete your own messages.");
          await store.remove(message);
          return { status: 200, body: { deleted: true } };
        }
        if (req.method === "POST" && messageMatch[2]) {
          const { reason } = z
            .object({ reason: z.string().trim().min(3).max(500) })
            .parse(parse());
          await store.report({
            id: randomUUID(),
            postId: id,
            originGeohash: message.originGeohash,
            authorId: message.authorId,
            reason,
            reporterId: user.id,
            createdAt: new Date().toISOString(),
          });
          return { status: 201, body: { reported: true } };
        }
      }
      if (req.method === "GET" && path === "/moderation/reports") {
        await moderator();
        return {
          status: 200,
          body: await store.reports(req.query.get("cursor") ?? undefined),
        };
      }
      const banMatch = path.match(/^\/moderation\/users\/([^/]+)$/);
      if (req.method === "PUT" && banMatch) {
        await moderator();
        const id = z
          .string()
          .regex(/^(guest|user):[a-zA-Z0-9_-]{1,128}$/)
          .parse(decodeURIComponent(banMatch[1]));
        const { banned } = z.object({ banned: z.boolean() }).parse(parse());
        await store.ban(id, banned);
        return { status: 200, body: { id, banned } };
      }
      throw new ApiError(404, "Route not found.");
    } catch (error) {
      if (error instanceof z.ZodError)
        return {
          status: 400,
          body: { error: error.issues[0]?.message ?? "Invalid input." },
        };
      if (error instanceof ApiError)
        return { status: error.status, body: { error: error.message } };
      console.error(
        "Request failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return {
        status: 500,
        body: { error: "Something went wrong. Please try again." },
      };
    }
  };
}
