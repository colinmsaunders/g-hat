# geohash.chat

Read anywhere. Post from where you are. A TypeScript monorepo for guest-first, geographically nested chat on AWS.

## Run locally

Requires Node.js 22.12+ and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The local API uses an in-memory store; no AWS account, credentials, or Docker are needed. Data resets when the API restarts. Registered accounts are enabled only on AWS. Opening `/` asks for location and suggests a room; if location is denied, enter a geohash or choose a city.

```sh
npm test
npm run build
npm run synth
```

`build` includes strict TypeScript checking. `synth` requires the frontend build first. No cloud deployment is performed by these commands.

## Included in Milestone 1

- React/Vite frontend with rooms at `/<geohash>`, child and parent navigation, optional browsing geolocation, required fresh posting location, activity-based smart zoom, and a responsive chat interface.
- Public room reads, guest sessions, optional Cognito email accounts, slash commands, and HTTP polling every five seconds while visible. Guest display names are not unique.
- Server-derived posting rooms with accuracy-based precision (1–8), freshness checks, and no persisted raw GPS coordinates.
- Atomic fan-out and count eviction across all room ancestors, bounded to eight prefixes. Messages never flow downward. Evicting one room copy does not affect other room copies.
- Independent newest-1,000 DynamoDB room feeds without time expiry, cursor pagination, request deduplication, guest and posting rate limits, message reporting, owner/moderator deletion, and moderator bans.
- CDK stack: HTTP API, Node.js Lambda, retained DynamoDB table with point-in-time recovery, Cognito, private S3 assets, CloudFront, optional Route 53/ACM domain, logs, and error alarm.
- Same API application in local and Lambda adapters; behavior tests and infrastructure assertions.

See [architecture and DynamoDB schema](docs/architecture.md), [API contracts](docs/api.md), and [deployment instructions](docs/deployment.md).

## Layout

| Directory         | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `apps/web`        | React UI, Cognito account flows, slash commands                      |
| `apps/api`        | Application routes, Lambda/local adapters, DynamoDB/in-memory stores |
| `packages/shared` | Validation, geohash geometry, smart zoom, shared types               |
| `infra`           | AWS CDK application                                                  |
| `test`            | Geographic, API behavior, and infrastructure tests                   |

## Scope and next milestone

This is an executable first milestone, not a claim of public-launch readiness. Public launch still needs traffic/load testing, alert routing, operational moderation coverage, and stronger guest abuse protection. Low-precision rooms share one partition and transactionally updated activity buckets; load-test those hot keys before promoting a busy service. Guest bans are identity-based and can be evaded by creating a new session; hashed-IP limits provide only a basic additional bound.

Other deliberate limits: polling instead of WebSockets; moderator actions exposed through authenticated APIs rather than a moderation UI; Cognito sign-up/confirmation/sign-in without a password-reset or token-refresh UI (sign in again after one hour); no account/guest history merging; no attachment uploads; no map tile service; no full-text search; no automated moderation. Schema v2 creates a new empty `DataV2` table on updates; existing v1 data is retained separately and requires an explicit migration. The coordinate illustration is decorative, not a geographic map. Messages are public; location is optional for browsing and required for posting. Raw coordinates are transiently sent for validation; only the derived geohash is persisted. Browser location can be spoofed.

## Commands

`/join 9q8yy`, `/out`, `/in b`, `/here`, `/nick Your Name` (guests), `/help`.

Enter sends; Shift+Enter creates a newline. View older messages pauses polling; return to live to resume. Local sessions and limits reset with the local API process.
