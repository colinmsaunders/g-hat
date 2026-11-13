# geochalk

Read anywhere. Post from where you are. A TypeScript monorepo for guest-first, geographically nested chat on AWS.

Live at **https://geochalk.com**, with the application in **us-west-2**, AWS account **451261323611**. CloudFront is global and its certificate remains in us-east-1.

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
- Server-derived precision-8 posting origins, fresh location checks, persistent HttpOnly guest cookies, and short-lived coarse observations for motion checks.
- Nine unconditional denormalized writes into independent rooms. Each room has 1,024 random Base32 slots; collisions replace posts without chronological eviction or post TTL.
- Full-room query pagination, timestamp sorting, per-identity/IP limits, duplicate/content/motion admission checks, reporting and replacement-safe moderation deletion.
- CDK: HTTP API, Lambda, separate post/control DynamoDB tables, Cognito, private S3, CloudFront, optional Route 53/ACM, logs, error alarms and storage metrics dashboard.
- Same API application in local and Lambda adapters; behavior tests and infrastructure assertions.

See [architecture and DynamoDB schema](docs/architecture.md), [API contracts](docs/api.md), and [deployment instructions](docs/deployment.md), and [traffic cost estimates](docs/costs.md).

## Layout

| Directory         | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `apps/web`        | React UI, Cognito account flows, slash commands                      |
| `apps/api`        | Application routes, Lambda/local adapters, DynamoDB/in-memory stores |
| `packages/shared` | Validation, geohash geometry, smart zoom, shared types               |
| `infra`           | AWS CDK application                                                  |
| `test`            | Geographic, API behavior, and infrastructure tests                   |

## Scope and next milestone

Geochalk architecture/schema v1 is deployed with fresh data in account 451261323611, with the application in us-west-2. New `PostsV1` and `ControlV1` tables use the existing random-slot model. Prior deployments are retained without copying posts or accounts; see the deployment guide for rollout status.

Remaining launch work: load/cost testing, alert routing, operational moderation, verified viewer-IP protection behind CloudFront, and broader content abuse handling. Browser GPS is spoofable; coarse motion checks can race. Full-room reads and durable moderation markers have growing read costs. Broad prefixes may become hot. These tradeoffs are documented in the architecture.

Other limits: polling rather than WebSockets, API-only moderator tools, no password-reset/token-refresh UI, no account/guest merging, attachments, full-text search or map tiles. Public precision-8 origins reveal location; raw GPS history is not stored. Optional Cognito tokens remain in localStorage; guest identity uses a secure cookie.

## Commands

`/join 9q8yy`, `/out`, `/in b`, `/here`, `/nick Your Name` (guests), `/help`.

Enter sends; Shift+Enter creates a newline. View older messages pauses polling; return to live to resume. Local sessions and limits reset with the local API process.
