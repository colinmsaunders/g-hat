# HTTP API — schema v1

All routes start with `/api`. JSON errors are `{error:string}`. Public room reads require no identity. Mutations require `x-geochalk-request: 1` plus the guest cookie or optional `Authorization: Bearer <Cognito ID token>`. Guest bearer tokens are no longer accepted.

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

The complete [Post payload and nine precision levels](architecture.md) define shared identity across copies. `postId` is 32 uppercase RFC 4648 Base32 characters; the first byte decoded from Base32, rendered as two lowercase hex characters, identifies its slot. `createdAt` is server ISO UTC time. `displayName` is a non-unique snapshot. Public `authorId` determines ownership, not the name. Location fields are transient; posts expose only the derived origin cell, which can still reveal sensitive whereabouts.

`Identity` is `{id,name,moderator}`. `Report` is `{id,postId,originGeohash,authorId,reason,reporterId,createdAt}`. Reasons are trimmed 3–500 characters; names 2–24 letters, digits, spaces or `_ . -`; content is plain text trimmed to 1–2,000 characters. Request bodies are capped at 16,000 characters.

Room responses contain up to 256 surviving unmoderated posts sorted newest first. Each room stores at most 256 slots; there is no promise of the latest 256. Cursors are room-specific and not snapshot isolation. Deleted posts are omitted from rooms, without tombstones in slots. All newly accepted posts are also retained in an append-only archive, including after deletion or slot eviction.

Posting is not HTTP-idempotent. There is no client request ID. Obtain a fresh fix on each attempt. Batch retries reuse the server post ID, but retrying an HTTP request can create another post. A 503 can mean partial publication; refresh before retrying. Duplicate text within 30 seconds is rejected as abuse rather than returning a previous result.

Codes include 409 conflicting immutable post ID, 400 malformed input/location, 401 missing/expired identity, 403 banned/unauthorized or missing request header, 404 unavailable post/route, 413 oversized body, 422 content/location risk, 429 rate/duplicate limit, 503 read-only or incomplete batch, and 500 unexpected dependency failure. Moderation/report lookup uses the archive, so slot eviction does not prevent it; missing or old unarchived IDs return 404.

Guest cookies last 30 days and are reused across visits. Optional Cognito signup/sign-in remains unchanged. Sign-out clears the Cognito token and returns to the existing guest cookie. Cognito token refresh, guest revocation and account/guest merging are not implemented.

## curl examples

Read all current posts in a room (`_` is the global room):

```sh
curl -fsS 'https://geochalk.com/api/rooms/_/messages'
```

There is no public GET-by-post-ID endpoint. To select a post still present in a room (requires jq):

```sh
POST_ID='YOUR_BASE32_POST_ID'
curl -fsS 'https://geochalk.com/api/rooms/_/messages' \
  | jq --arg id "$POST_ID" '.posts[] | select(.postId == $id)'
```

Create a guest session, then publish with POST, not PUT. Use your actual fresh latitude, longitude and GPS accuracy in meters; the timestamp below is generated at submission. Accuracy must be positive and no more than 5,000 meters. The server chooses the posting room from your coordinates.

```sh
COOKIE_JAR=$(mktemp)
curl -fsS -c "$COOKIE_JAR" 'https://geochalk.com/api/sessions' \
  -H 'Content-Type: application/json' \
  -H 'x-geochalk-request: 1' \
  -d '{"name":"Curl user"}'

LAT='YOUR_LATITUDE'
LON='YOUR_LONGITUDE'
ACCURACY='YOUR_ACCURACY_IN_METERS'

curl -fsS -b "$COOKIE_JAR" 'https://geochalk.com/api/messages' \
  -H 'Content-Type: application/json' \
  -H 'x-geochalk-request: 1' \
  -d "{\"content\":\"Hello from here!\",\"location\":{\"latitude\":$LAT,\"longitude\":$LON,\"accuracy\":$ACCURACY,\"timestamp\":$(($(date +%s) * 1000))}}"
```

Successful publication returns 201 with the new Base32 `postId` and server-derived `originGeohash`. The archived original remains stored even after the post is deleted from rooms.
