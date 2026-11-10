# HTTP API — location-derived posting

All routes begin with `/api`. JSON requests/responses. Mutations use `Authorization: Bearer <guest token or Cognito ID token>`; reads are public except `/me` and moderation. Errors have `{ "error": "Human-readable message" }`. Typical codes: 400 validation, 401 missing/expired identity, 403 forbidden/banned, 404 missing resource, 409 deletion contention, 410 accepted post since evicted, 413 body size, 429 rate limit or write contention, 503 activity unavailable, 500 internal error. Bodies are limited to 16,000 characters before parsing. Message text is limited to 2,000 characters after trimming; rendered as plain text.

| Method | Path                               | Input                                                    | Success                                                       |
| ------ | ---------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/health`                          | —                                                        | 200 `{ok:true}`                                               |
| POST   | `/sessions`                        | `{name?:string}` (2–24 letters, digits, spaces, `_ . -`) | 201 `{token, identity, expiresAt}`                            |
| GET    | `/me`                              | Bearer                                                   | 200 `Identity`                                                |
| PATCH  | `/me`                              | Guest bearer, `{name}`                                   | 200 updated `Identity`                                        |
| GET    | `/rooms/suggest?geohash=9q8yyk8y`  | Prefix 1–8                                               | 200 `{room, counts, windowMinutes:"15–20", targetMessages:3}` |
| GET    | `/rooms/:prefix/messages?cursor=…` | Optional cursor                                          | 200 `{messages:Message[], cursor?:string}`                    |
| POST   | `/messages`                        | Bearer, `{text,requestId:UUID,location}`                 | 201 `Message` (same message on retry)                         |
| DELETE | `/messages/:id`                    | Owner/moderator bearer                                   | 200 `{deleted:true}`                                          |
| POST   | `/messages/:id/reports`            | Bearer, `{reason:string}` (3–500 chars)                  | 201 `{reported:true}`                                         |
| GET    | `/moderation/reports?cursor=…`     | Moderator bearer                                         | 200 `{reports:Report[],cursor?:string}`                       |
| PUT    | `/moderation/users/:actorId`       | Moderator bearer, `{banned:boolean}`                     | 200 `{id,banned}`                                             |

```typescript
interface Identity {
  id: string;
  name: string;
  moderator: boolean;
}
interface Message {
  id: string;
  room: string;
  authorId: string;
  name: string;
  text: string;
  createdAt: string;
  deleted?: boolean;
}
interface Report {
  id: string;
  messageId: string;
  room: string;
  reason: string;
  reporterId: string;
  createdAt: string;
}
```

`location` is `{latitude:number, longitude:number, accuracy:number, timestamp:number}`. Accuracy is a positive radius in meters, at most 5,000. Timestamp is epoch milliseconds, no more than 60 seconds old or five seconds in the future. The server derives the authoritative `Message.room` at adaptive precision 1–8. Extra `room`/`geohash` parameters are ignored. `POST /rooms/:prefix/messages` is no longer supported (404). Raw location fields are not persisted. Permission denial prevents posting but does not restrict reads.

Each room returns only its independently retained newest 1,000 posts. There is no time-based message expiration. Canonical content is removed after its last feed copy is evicted. A retry whose receipt survives but whose post is gone returns 410. Reports may reference evicted posts. Deleted tombstones occupy feed slots until count eviction.

`createdAt` is a server-generated ISO UTC timestamp. Authors' display names are snapshots at post time. Names are non-unique; use IDs for ownership and bans. Deleted messages keep IDs, author metadata and timestamps, but return empty text. All room read endpoints are public, including author IDs.

Clients must generate one UUID per intended post and preserve it across network retries. A new UUID means a new post. Obtain a fresh location for each attempt, retaining the UUID across retries even if the viewing room changes. A retry does not move an already accepted post. Slash commands are interpreted by the browser, not persisted as commands. The API accepts plain text including strings beginning with `/` from other clients.

Registered-user signup, verification and sign-in use Cognito directly. The deployed `/config.json` provides `region`, `userPoolId`, `userPoolClientId` and `apiUrl`; these are public configuration, not credentials. Tokens are stored in browser localStorage; keep the site free of untrusted script and review CSP/auth storage before expanding integrations. Signing out removes the browser token but does not revoke an already copied guest token. This milestone has no server-side session revocation endpoint.
