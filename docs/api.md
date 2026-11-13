# HTTP API — schema v3

All routes start with `/api`. JSON errors are `{error:string}`. Public room reads require no identity. Mutations require `x-geohash-request: 1` plus the guest cookie or optional `Authorization: Bearer <Cognito ID token>`. Guest bearer tokens are no longer accepted.

| Method | Path                                       | Input                         | Success                                                                             |
| ------ | ------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/health`                                  | —                             | `{ok:true}`                                                                         |
| POST   | `/sessions`                                | `{name?:string}`              | 201 `{identity,expiresAt}` plus HttpOnly cookie; 200 if valid cookie already exists |
| GET    | `/me`                                      | Cookie or Cognito             | `Identity`                                                                          |
| PATCH  | `/me`                                      | Guest cookie, `{name}`        | Updated identity                                                                    |
| GET    | `/rooms/suggest?geohash=c23nb62w`          | Prefix 0–8 (`_` for 0)        | `{room,counts,windowMinutes:15,targetMessages:3}`                                   |
| GET    | `/rooms/:prefix/messages?cursor=…`         | Optional cursor               | `{posts:Post[],cursor?:string}`                                                     |
| POST   | `/messages`                                | `{content,location}`          | 201 `Post`                                                                          |
| DELETE | `/messages/:postId?originGeohash=c23nb62w` | Owner or moderator            | `{deleted:true}`                                                                    |
| POST   | `/messages/:postId/reports`                | `{originGeohash,reason}`      | 201 `{reported:true}`                                                               |
| GET    | `/moderation/reports?cursor=…`             | Moderator                     | `{reports:Report[],cursor?:string}`                                                 |
| PUT    | `/moderation/users/:actorId`               | Moderator, `{banned:boolean}` | `{id,banned}`                                                                       |

Example posting request (timestamp must be the fresh browser fix timestamp, not this illustration):

```json
{
  "content": "Hello from here!",
  "location": {
    "latitude": 37.7749,
    "longitude": -122.4194,
    "accuracy": 25,
    "timestamp": 1794412800000
  }
}
```

Location accuracy must be positive and at most 5,000 meters; timestamp is epoch milliseconds within 60 seconds of receipt, allowing five seconds future skew. Server-derived `originGeohash` always has eight characters. Extra viewing-room parameters are ignored. Room-addressed posting is unsupported. Missing permission/fix prevents posting, not browsing.

The complete [Post payload and nine precision levels](architecture.md) define shared identity across copies. `postId` is 32 uppercase RFC 4648 Base32 characters; the first two identify its slot. `createdAt` is server ISO UTC time. `displayName` is a non-unique snapshot. Public `authorId` determines ownership, not the name. Location fields are transient; posts expose only the derived origin cell, which can still reveal sensitive whereabouts.

`Identity` is `{id,name,moderator}`. `Report` is `{id,postId,originGeohash,authorId,reason,reporterId,createdAt}`. Reasons are trimmed 3–500 characters; names 2–24 letters, digits, spaces or `_ . -`; content is plain text trimmed to 1–2,000 characters. Request bodies are capped at 16,000 characters.

Room responses contain up to 50 surviving unmoderated posts sorted newest first. Each room stores at most 1,024 slots; there is no promise of the latest 1,024. Cursors are room-specific and not snapshot isolation. Deleted posts are omitted, without tombstones in slots.

Posting is not HTTP-idempotent. There is no client request ID. Obtain a fresh fix on each attempt. Batch retries reuse the server post ID, but retrying an HTTP request can create another post. A 503 can mean partial publication; refresh before retrying. Duplicate text within 30 seconds is rejected as abuse rather than returning a previous result.

Codes include 400 malformed input/location, 401 missing/expired identity, 403 banned/unauthorized or missing request header, 404 unavailable post/route, 413 oversized body, 422 content/location risk, 429 rate/duplicate limit, 503 read-only or incomplete batch, and 500 unexpected dependency failure. Reads of already evicted posts for moderation can return 404.

Guest cookies last 30 days and are reused across visits. Optional Cognito signup/sign-in remains unchanged. Sign-out clears the Cognito token and returns to the existing guest cookie. Cognito token refresh, guest revocation and account/guest merging are not implemented.
