# Architecture — random room slots (schema v3)

Read anywhere. Post from your reported current location. The TypeScript monorepo, Lambda HTTP API, DynamoDB, React/Vite, Cognito and CDK remain in place. This revision replaces adaptive precision and newest-1,000 retention. It is implemented locally and has not been deployed.

## Eight geographic levels

A room is a lowercase geohash prefix of length 1–8. There is no precision-zero global room. A new post always has a precision-8 origin, regardless of the room being viewed. For origin `c23nb62w`, the eight copies are:

| Precision | Room partition |
| --------- | -------------- |
| 1         | `c`            |
| 2         | `c2`           |
| 3         | `c23`          |
| 4         | `c23n`         |
| 5         | `c23nb`        |
| 6         | `c23nb6`       |
| 7         | `c23nb62`      |
| 8         | `c23nb62w`     |

Each character adds five bits of geographic subdivision. Copies flow upward, never into siblings or descendants. Precision describes the encoded cell, not confidence in the reported location. Accuracy up to 5 km is accepted even though the precision-8 cell is much smaller. This explicitly replaces adaptive posting precision.

## Post identity and full payload

`postId` is 20 cryptographically random bytes encoded most-significant-bit first with RFC 4648 Base32 alphabet `ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`. It is exactly 32 characters with no padding or time component. `slot = postId.slice(0, 2)` has 10 uniform random bits and 1,024 possible values. Geohashes use a different, lowercase alphabet.

```typescript
interface Post {
  postId: string; // immutable random identity, 32 uppercase Base32 characters
  originGeohash: string; // immutable precision-8 server-derived origin
  authorId: string; // guest:<UUID> or user:<Cognito subject>
  displayName: string; // non-unique author name snapshot
  content: string; // trimmed plain text, 1–2,000 characters
  createdAt: string; // server ISO UTC creation timestamp
}
```

Every item contains all six fields plus `pk = roomPrefix`, `sk = slot`. The same post ID and payload are copied to all eight prefixes. Identity is distinct from the slot: many unrelated posts can occupy that slot over time. There is no separate canonical body, reference lookup, feed list, receipt or activity bucket.

## Storage, retention and concurrent writes

CDK creates `PostsV3` (on-demand, encrypted, retained, PITR, no TTL) and `ControlV3` (on-demand, encrypted, retained, TTL on `expiresAt`). Both use string `pk`/`sk`, with no secondary indexes or explicit sharding.

After admission, a single batch contains eight unconditional full-item puts. Unprocessed items retry up to seven batch attempts with exponential backoff and jitter; SDK transport retries also apply. Conditions, transactions and revision locks are absent from normal posting. Batch operations overwrite existing items and are not atomic as a group. See [AWS BatchWriteItem semantics](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html).

A delayed older write may replace a newer one. Zoom levels can disagree. Exhausted retries report 503; some copies may already exist. There is no rollback or API idempotency receipt. Clients should refresh before retrying an uncertain publication; a new accepted HTTP attempt creates a new ID. Retries inside a batch retain the original ID.

A room contains at most 1,024 posts, often fewer while filling. Under independent uniform subsequent post IDs, a post survives n writes to that room with probability `(1023/1024)^n`. Retries of the same ID are correlated and are not independent trials. Room eviction means overwriting one slot; it never triggers deletes elsewhere. There is no FIFO queue, cleanup task, retention TTL or strict newest-wins guarantee. Quiet rooms retain surviving posts indefinitely. Retention between ancestor rooms is independent operationally, but collision events can be correlated because the same slot is used across the eight copies.

## Reading and moderation

Read every Query page for the requested partition, following `LastEvaluatedKey` through the [DynamoDB 1 MB pagination boundary](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html). Query moderation markers separately, filter matching IDs, then sort by `createdAt` descending with `postId` descending as tie-breaker. Return 50 posts and a room-bound timestamp/ID cursor. Cursor pagination is best effort, not a snapshot; concurrent writes can change subsequent pages. Strongly consistent individual queries do not create a multi-page snapshot. Sort-key order is never interpreted as recency.

Deletion/reporting supplies `originGeohash` plus `postId`. The store looks for that exact ID in any surviving ancestor copy. Owner/moderator deletion first writes eight body-free moderation markers, then conditionally deletes each slot only if its `postId` still matches. Replacement posts survive. Markers also hide delayed replays of the deleted ID. Markers and reports have no expiry and can grow beyond the bounded post storage; this deliberate moderation metadata tradeoff needs future retention policy. If all copies have vanished, lookup returns 404. Ban admission blocks future posts; removing already published posts requires targeted deletion.

Smart zoom counts currently surviving, unmoderated posts created in the last 15 minutes, choosing the deepest room with at least three. It does not count historical writes that collided away. It queries up to eight rooms; this avoids additional posting fanout but adds read cost.

## Guest identity and admission

Guests receive a 30-day `__Host-geohash_guest` cookie, `Secure; HttpOnly; SameSite=Lax; Path=/`, without a Domain attribute. Only its SHA-256 hash is stored server-side. Local loopback development uses an unprefixed cookie without Secure. Sessions enforce logical expiry even before TTL cleanup. Existing cookies are reused. Optional Cognito ID tokens remain supported and verified; only the moderators group grants moderator rights. Mutations require the custom `x-geohash-request: 1` header; there is no cross-origin CORS permission. This prevents cross-origin form submissions using ambient cookies. Cognito tokens remain in localStorage; guest secrets do not.

Before any slot write:

1. Validate identity, content length, finite coordinate ranges, accuracy `(0,5000]` meters, location age at most 60 seconds and future skew at most five seconds. The browser requests a fresh fix for every Send.
2. Reject banned identities, control characters and more than five links.
3. Enforce fixed-window atomic counters: 10 attempts per identity/minute and 30 per hashed connection IP/minute. Guest creation is limited to five per IP/minute; reports to five per identity/minute. Rejected later checks and failed publications can consume attempts. Windows can burst at boundaries.
4. Check duplicate text within 30 seconds, implied motion above 350 m/s with a 10 km minimum allowance, and A→B→A round trips over 50 km within 15 minutes. Motion uses server receipt times, never client fix timestamps.
5. Save at most three coarse precision-5 observations, uncertainty allowances, server receipt times and text hashes, expiring logically after 30 minutes. No raw GPS history is persisted. DynamoDB physical TTL deletion is asynchronous. The optional location-risk hook can integrate IP-geolocation evidence; no external service is configured or called.

These are lightweight heuristics, not proof of physical presence. Guest resets and spoofed reports remain possible. Observation updates can race; rate counters are atomic but the whole admission sequence is not a transaction. API Gateway's connection IP behind CloudFront may be an edge IP: its limit is a conservative shared backstop, not verified viewer-IP protection. Do not trust arbitrary forwarded IP headers. Broad content classification, operational moderation and authenticated viewer-IP controls remain gaps. Request bodies and raw coordinates must not be logged.

## Operations and migration

API responses remain uncached; CloudFront read caching is an optional future optimization. A CloudWatch dashboard includes consumed capacity, throttling and Query/BatchWriteItem latency, alongside existing Lambda error alarms. No sharding or local secondary indexes are added. Broad prefixes may get hot; measure before changing partition design. Full-room reads and accumulating moderation markers need load/cost testing. Alert notification routing is still operational work.

Schema v3 uses new empty tables. Removing the old `DataV2` CDK resource retains its physical table under its existing retention policy. Legacy data is neither converted nor silently mixed into slots. Existing guest bearer sessions are replaced by new cookie sessions. API contracts change together with the frontend; deploy as a coordinated update with downtime permitted. Existing region-copy scripts describe schema v2 only and must not be used as a v3 migration.

The current recorded deployment targets AWS account **451261323611**, application region **us-west-2**, with the global edge/certificate stack in us-east-1. This task does not deploy or change AWS authentication. At a future deployment, verify caller identity, deploy the western backend, refresh the recorded table outputs, then coordinate edge assets/config. Old retained data and backup disposal are separate explicit operations.
