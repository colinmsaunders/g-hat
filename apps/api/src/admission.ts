import { createHash } from "node:crypto";
import { bounds, encode, type PostingLocation } from "@geohash-chat/shared";
import {
  ApiError,
  OBSERVATION_TTL_SECONDS,
  type Observation,
  type Store,
} from "./store";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export type LocationRiskCheck = (input: {
  ip: string;
  location: PostingLocation;
  receivedAt: number;
}) => Promise<"allow" | "deny">;
function distance(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const rad = Math.PI / 180;
  const dlat = (b.latitude - a.latitude) * rad,
    dlon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dlon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function center(observation: Observation) {
  const b = bounds(observation.geohash);
  return {
    latitude: (b.north + b.south) / 2,
    longitude: (b.east + b.west) / 2,
  };
}
export function validateContent(content: string) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content))
    throw new ApiError(400, "Post contains unsupported control characters.");
  if ((content.match(/https?:\/\//gi) ?? []).length > 5)
    throw new ApiError(422, "Too many links in one post.");
}
export function checkMotion(
  history: Observation[],
  location: PostingLocation,
  now: number,
) {
  for (const previous of history) {
    const elapsed = Math.max(0, (now - previous.receivedAt) / 1000);
    const travel = Math.max(
      0,
      distance(center(previous), location) -
        previous.accuracy -
        location.accuracy,
    );
    if (travel > Math.max(10_000, elapsed * 350))
      throw new ApiError(
        422,
        "Location changed implausibly quickly. Wait or obtain a more accurate fix.",
      );
  }
  const [home, away] = history.slice(-2);
  if (
    home &&
    away &&
    now - home.receivedAt < 15 * 60_000 &&
    distance(center(home), center(away)) > 50_000 &&
    distance(center(home), location) < 10_000
  )
    throw new ApiError(
      422,
      "Implausible geographic round trip. Please try again later.",
    );
}
export async function admitPost(
  store: Store,
  actor: string,
  sourceIp: string,
  location: PostingLocation,
  content: string,
  now: number,
  riskCheck?: LocationRiskCheck,
) {
  validateContent(content);
  if (await store.isBanned(actor))
    throw new ApiError(403, "This identity is banned.");
  await store.rate(`post:actor:${actor}`, 10, now);
  await store.rate(`post:ip:${hash(sourceIp)}`, 30, now);
  const history = (await store.observations(actor, now))
    .filter(
      (p) =>
        p.receivedAt > now - OBSERVATION_TTL_SECONDS * 1000 &&
        p.receivedAt <= now,
    )
    .sort((a, b) => a.receivedAt - b.receivedAt);
  const contentHash = hash(content.toLowerCase().replace(/\s+/g, " "));
  if (
    history.some(
      (p) => p.contentHash === contentHash && now - p.receivedAt < 30_000,
    )
  )
    throw new ApiError(
      429,
      "Please wait before posting the same content again.",
    );
  checkMotion(history, location, now);
  if (
    riskCheck &&
    (await riskCheck({ ip: sourceIp, location, receivedAt: now })) === "deny"
  )
    throw new ApiError(
      422,
      "Location risk check failed. Please obtain a new fix.",
    );
  // Only a coarse cell and uncertainty allowance persist, never the raw coordinates.
  const observation: Observation = {
    geohash: encode(location.latitude, location.longitude, 5),
    accuracy: location.accuracy + 5000,
    receivedAt: now,
    contentHash,
  };
  await store.observe(actor, [...history, observation].slice(-3), now);
}
