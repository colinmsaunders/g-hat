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
  type Message,
} from "@geohash-chat/shared";
import { ApiError, type Store } from "./store";
export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  token?: string;
  body?: string;
  ip: string;
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function createApp(
  store: Store,
  verifyUser?: (token: string) => Promise<Identity>,
) {
  return async (req: Request): Promise<{ status: number; body: unknown }> => {
    try {
      if ((req.body?.length ?? 0) > 16000)
        throw new ApiError(413, "Request too large.");
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
        if (!token)
          throw new ApiError(401, "Sign in or start a guest session.");
        if (token.startsWith("guest_")) {
          const session = await store.session(hash(token));
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
        const token = `guest_${randomBytes(32).toString("base64url")}`;
        const identity = {
          id: `guest:${randomUUID()}`,
          name,
          moderator: false,
        };
        const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
        await store.guest(hash(token), { identity, expiresAt }, ip);
        return { status: 201, body: { token, identity, expiresAt } };
      }
      if (req.method === "GET" && path === "/me")
        return { status: 200, body: await authenticate() };
      if (req.method === "PATCH" && path === "/me") {
        const user = await authenticate();
        if (!req.token?.startsWith("guest_"))
          throw new ApiError(
            400,
            "Registered names are managed in your account.",
          );
        const { name } = z.object({ name: nameSchema }).parse(parse());
        await store.rename(hash(req.token), name);
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
            windowMinutes: "15–20",
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
        const { text, requestId, location } = postSchema.parse(parse());
        let room: string;
        try {
          room = postingRoom(location);
        } catch (error) {
          if (error instanceof z.ZodError) throw error;
          throw new ApiError(400, (error as Error).message);
        }
        const message: Message = {
          id: randomUUID(),
          room,
          authorId: user.id,
          name: user.name,
          text,
          createdAt: new Date().toISOString(),
        };
        return { status: 201, body: await store.post(message, requestId, ip) };
      }
      const messageMatch = path.match(/^\/messages\/([^/]+)(\/reports)?$/);
      if (messageMatch) {
        const user = await authenticate();
        const id = z.uuid().parse(messageMatch[1]);
        const message = await store.get(id);
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
            messageId: id,
            room: message.room,
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
