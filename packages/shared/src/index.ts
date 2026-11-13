import { z } from "zod";
export const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
export const roomSchema = z
  .string()
  .regex(
    /^(?:_|[0-9bcdefghjkmnpqrstuvwxyz]{1,8})$/,
    "Use _ for the world or a geohash of 1–8 characters.",
  );
export const ROOM_CAPACITY = 256;
export const POST_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const POST_ID_BYTES = 20;
export const postIdSchema = z
  .string()
  .regex(/^[A-Z2-7]{32}$/, "Invalid Base32 post ID.");
export const originSchema = roomSchema.length(
  8,
  "Posting origins must have precision 8.",
);
/** RFC 4648 Base32, most significant bit first, exactly 160 bits and no padding. */
export function encodePostId(bytes: Uint8Array): string {
  if (bytes.length !== POST_ID_BYTES)
    throw new Error("Post IDs require 20 random bytes.");
  let result = "",
    value = 0,
    bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += POST_ID_ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return result;
}
export function postSlot(postId: string): string {
  const id = postIdSchema.parse(postId);
  // Decode the first byte: five bits from character 0 and three from character 1.
  const byte =
    (POST_ID_ALPHABET.indexOf(id[0]) << 3) |
    (POST_ID_ALPHABET.indexOf(id[1]) >>> 2);
  return byte.toString(16).padStart(2, "0");
}
export const LOCATION_MAX_AGE_MS = 60_000;
export const LOCATION_FUTURE_SKEW_MS = 5_000;
export const locationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracy: z
    .number()
    .finite()
    .positive()
    .max(5000, "Location accuracy must be within 5 km."),
  timestamp: z.number().finite().int().nonnegative(),
});
export type PostingLocation = z.infer<typeof locationSchema>;
export const postSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  location: locationSchema,
});
export const nameSchema = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[\p{L}\p{N} _.-]+$/u);
export interface Post {
  postId: string;
  originGeohash: string;
  authorId: string;
  displayName: string;
  content: string;
  createdAt: string;
}
export interface Identity {
  id: string;
  name: string;
  moderator: boolean;
}
export interface Page {
  posts: Post[];
  cursor?: string;
}
export function ancestors(room: string): string[] {
  roomSchema.parse(room);
  return room === "_"
    ? ["_"]
    : [
        "_",
        ...Array.from({ length: room.length }, (_, i) => room.slice(0, i + 1)),
      ];
}
export function encode(lat: number, lon: number, precision = 8): string {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180 ||
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > 8
  )
    throw new Error("Invalid coordinates or precision");
  if (precision === 0) return "_";
  let south = -90,
    north = 90,
    west = -180,
    east = 180,
    even = true,
    bits = 0,
    value = 0,
    hash = "";
  while (hash.length < precision) {
    const mid = even ? (west + east) / 2 : (south + north) / 2;
    const high = (even ? lon : lat) >= mid;
    value = (value << 1) + (high ? 1 : 0);
    if (even) {
      if (high) west = mid;
      else east = mid;
    } else {
      if (high) south = mid;
      else north = mid;
    }
    even = !even;
    if (++bits === 5) {
      hash += alphabet[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}
export function bounds(room: string) {
  roomSchema.parse(room);
  let south = -90,
    north = 90,
    west = -180,
    east = 180,
    even = true;
  for (const c of room === "_" ? "" : room) {
    const value = alphabet.indexOf(c);
    for (let mask = 16; mask; mask >>= 1) {
      const mid = even ? (west + east) / 2 : (south + north) / 2;
      if (even) {
        if (value & mask) west = mid;
        else east = mid;
      } else {
        if (value & mask) south = mid;
        else north = mid;
      }
      even = !even;
    }
  }
  return { south, north, west, east };
}
export function chooseRoom(
  hash: string,
  counts: Record<string, number>,
  target = 3,
): string {
  const levels = ancestors(hash);
  return (
    levels.filter((p) => (counts[p] ?? 0) >= target).at(-1) ??
    hash.slice(0, Math.min(5, hash.length))
  );
}
export type Command =
  | { kind: "go"; room: string }
  | { kind: "name"; name: string }
  | { kind: "help" }
  | { kind: "locate" };
export function command(text: string, room: string): Command | null {
  if (!text.startsWith("/")) return null;
  const [verb, ...args] = text.trim().split(/\s+/);
  const arg = args.join(" ");
  if (verb === "/join")
    return { kind: "go", room: roomSchema.parse(arg.toLowerCase()) };
  if (verb === "/out") {
    if (room === "_") throw new Error("Already at the widest room.");
    return { kind: "go", room: room.length === 1 ? "_" : room.slice(0, -1) };
  }
  if (verb === "/in") {
    if (room.length === 8) throw new Error("Already at maximum precision.");
    if (arg.length !== 1 || !alphabet.includes(arg))
      throw new Error("Use /in followed by one geohash character.");
    return { kind: "go", room: (room === "_" ? "" : room) + arg };
  }
  if (verb === "/nick") return { kind: "name", name: nameSchema.parse(arg) };
  if (verb === "/help") return { kind: "help" };
  if (verb === "/here") return { kind: "locate" };
  throw new Error("Unknown command. Try /help.");
}

/** Precision 8 identifies a cell, not verified physical location or measurement accuracy. */
export function postingRoom(input: PostingLocation, now = Date.now()): string {
  const location = locationSchema.parse(input);
  z.number()
    .min(
      now - LOCATION_MAX_AGE_MS,
      "Location is stale. Request a fresh position.",
    )
    .max(now + LOCATION_FUTURE_SKEW_MS, "Location timestamp is in the future.")
    .parse(location.timestamp);
  return encode(location.latitude, location.longitude, 8);
}
