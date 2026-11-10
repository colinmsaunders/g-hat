import { z } from "zod";
export const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
export const roomSchema = z
  .string()
  .regex(
    /^[0-9bcdefghjkmnpqrstuvwxyz]{1,8}$/,
    "Use a geohash of 1–8 characters.",
  );
export const ROOM_CAPACITY = 1000;
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
  text: z.string().trim().min(1).max(2000),
  requestId: z.uuid(),
  location: locationSchema,
});
export const nameSchema = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[\p{L}\p{N} _.-]+$/u);
export interface Message {
  id: string;
  room: string;
  authorId: string;
  name: string;
  text: string;
  createdAt: string;
  deleted?: boolean;
}
export interface Identity {
  id: string;
  name: string;
  moderator: boolean;
}
export interface Page {
  messages: Message[];
  cursor?: string;
}
export function ancestors(room: string): string[] {
  roomSchema.parse(room);
  return Array.from({ length: room.length }, (_, i) => room.slice(0, i + 1));
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
    precision < 1 ||
    precision > 8
  )
    throw new Error("Invalid coordinates or precision");
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
  for (const c of room) {
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
    if (room.length === 1) throw new Error("Already at the widest room.");
    return { kind: "go", room: room.slice(0, -1) };
  }
  if (verb === "/in") {
    if (room.length === 8) throw new Error("Already at maximum precision.");
    if (arg.length !== 1 || !alphabet.includes(arg))
      throw new Error("Use /in followed by one geohash character.");
    return { kind: "go", room: room + arg };
  }
  if (verb === "/nick") return { kind: "name", name: nameSchema.parse(arg) };
  if (verb === "/help") return { kind: "help" };
  if (verb === "/here") return { kind: "locate" };
  throw new Error("Unknown command. Try /help.");
}

/** Precision is a resolution choice, not proof that the uncertainty circle is inside the cell. */
export function postingRoom(input: PostingLocation, now = Date.now()): string {
  const location = locationSchema.parse(input);
  z.number()
    .min(
      now - LOCATION_MAX_AGE_MS,
      "Location is stale. Request a fresh position.",
    )
    .max(now + LOCATION_FUTURE_SKEW_MS, "Location timestamp is in the future.")
    .parse(location.timestamp);
  const metersPerDegree = (Math.PI * 6371008.8) / 180;
  for (let precision = 8; precision >= 1; precision--) {
    const room = encode(location.latitude, location.longitude, precision);
    const b = bounds(room);
    const width =
      (b.east - b.west) *
      metersPerDegree *
      Math.cos((location.latitude * Math.PI) / 180);
    const height = (b.north - b.south) * metersPerDegree;
    if (Math.min(width, height) >= 2 * location.accuracy) return room;
  }
  throw new Error(
    "Location is too imprecise at this latitude. Try a better location fix.",
  );
}
