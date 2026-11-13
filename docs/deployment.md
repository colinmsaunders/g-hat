# Deploy geochalk v1 to AWS

Geochalk uses **https://geochalk.com**, AWS account **451261323611**, an application backend in **us-west-2**, and a global CloudFront distribution with its ACM certificate in **us-east-1**. Architecture/schema numbering starts at **v1**, with the random-slot storage model described in [architecture.md](architecture.md).

## Fresh deployment and retained history

The rename creates `Geochalk` (eastern edge stack) and `GeochalkWest` (western application stack), with new `PostsV1` and `ControlV1` tables, Cognito pools, APIs, Lambda functions, buckets, IAM roles, logs, dashboards and alarms. The eastern stack retains the existing two-region topology with an unused, read-only regional backend. Only the western backend serves the final site.

The user authorized fresh data and retention of the predecessor resources. No posts, accounts, sessions, reports or bans are copied. New domain-local storage uses `geochalk.session` and `geochalk.name`; guest cookies use `__Host-geochalk_guest` (`geochalk_guest` locally), and mutation requests require `x-geochalk-request: 1`. Users register again on the new site.

The predecessor stacks, domain, physical resource names and data remain unchanged. Their identifiers are documented accurately in [deployment history](history/legacy-deployment.md) and [region migration history](history/legacy-region-migration.md). `scripts/migrate-legacy-region.py` is historical schema-v2 tooling, not a geochalk v1 migration. Do not deploy old stack names from the current CDK app. Decommissioning retained resources is a separate operation.

## Deployment sequence

`infra/app.ts` pins account 451261323611 and rejects another `CDK_DEFAULT_ACCOUNT`. `cdk.json` uses the geochalk.com hosted zone `Z03155483MXGI0J176IXN`. Verify identity before deployment:

```sh
aws sts get-caller-identity # Account must be 451261323611
npm ci
npm test
```

For initial provisioning, deploy `Geochalk` with `enableWest: false` and no `backendTarget`. This creates the new distribution, certificate and DNS with a read-only bootstrap backend:

```sh
npx cdk diff Geochalk --no-change-set
npx cdk deploy Geochalk --outputs-file geochalk-edge-outputs.json
```

Set `edgeDistributionId` in cdk.json from the `Geochalk.DistributionId` output and set `enableWest: true`. Deploy the western stack:

```sh
npx cdk diff GeochalkWest --no-change-set
npx cdk deploy GeochalkWest --outputs-file geochalk-west-outputs.json
```

Set `backendTarget` from the actual western outputs: `region: us-west-2`, `apiId: ApiId`, `bucketName: BucketName`, `tableName: TableName`, `userPoolId: UserPoolId`, and `userPoolClientId: UserPoolClientId`. Then deploy `Geochalk` again to switch origins and invalidate CloudFront. Never manufacture physical identifiers by replacing text in old outputs.

For subsequent coordinated updates:

```sh
npx cdk diff GeochalkWest Geochalk --no-change-set
npm run deploy
```

If western resource outputs change, refresh `backendTarget` before deploying the edge stack. Keep `eastReadOnly: true` and `westReadOnly: false`. Both regions are bootstrapped. Output files are ignored and named `geochalk-edge-outputs.json` and `geochalk-west-outputs.json`; prior local snapshots use the `legacy-` prefix.

S3 is private with Origin Access Control restricted to the new distribution. The west stack manages its bucket policy; the edge stack imports that bucket. `/api/*` is uncached and forwards Authorization, cookies and the request header. Only `/` and valid geographic room paths rewrite to the SPA. The stack does not configure `www` or alter registrar delegation.

## Verification

Check HTTPS, `/config.json`, built assets, `/_`, a geographic deep link, `/api/health`, room reads and smart zoom. Confirm the production config and CloudFront origins use the new western resources. Check secure guest cookies, authenticated `/me`, missing-auth and invalid-location rejection, and request-header protection without publishing test posts.

Browser geolocation, successful posting/deletion/reporting, account email delivery and load testing remain manual acceptance checks. Check permission denial, stale/future fixes, low accuracy, geographic jumps, random collisions, delayed writes, partial fanout and conditional deletion. Do not log request bodies or raw coordinates.

## Moderators and operations

Assign a verified Cognito account to the `moderators` group:

```sh
aws cognito-idp admin-add-user-to-group \
  --user-pool-id YOUR_GEOCHALK_USER_POOL_ID \
  --username YOUR_COGNITO_USERNAME \
  --group-name moderators
```

Sign in again for an updated token. See [API contracts](api.md). There is no operator console or audit event stream yet.

Room posts have no TTL; collisions overwrite 256 hex slots. `PostArchiveV1` retains every new original post by full ID, with PITR and no TTL. It is append-only: room deletion/moderation never deletes or modifies originals. Controls expire sessions, counters and coarse observations via TTL; reports, bans and moderation markers have no expiry. Room, control and archive tables, pools and buckets are retained on stack removal. Old resources remain billable and may contain old content.

Configure alarm notification routing and budgets, then measure full-room reads, broad-prefix traffic and moderation storage growth. API throttling is 100 requests/second with a 200 burst, not a cost ceiling. Viewer-IP verification behind CloudFront remains future work. Keep dependency upgrades separate from this rename; recheck the lockfile audit before launch.

## Rollout status

Deployed and verified on 2026-11-13. `GeochalkWest` reached `CREATE_COMPLETE`; `Geochalk` reached `UPDATE_COMPLETE`. CloudFront distribution `E2KGR9JAO1J2EU` reports `Deployed` with the new western S3 and API origins and alias `geochalk.com`.

Active western resources:

- API: `ptnlpufnn1`.
- Lambda: `GeochalkWest-ApiHandler5E7490E8-BOhUE18GF4js`.
- Assets: `geochalkwest-webassets27872646-rbdhhh5tsgxl`.
- Posts: `GeochalkWest-PostsV1DF14853D-7XHIOY6LGR94`.
- Controls: `GeochalkWest-ControlV1DD0E9618-JBRLPTHZH0W8`.
- Cognito: `us-west-2_GjbVKnolf`, client `2vft072gcdacmjn4lh6ju5co47`, Essentials tier.

The production build, 33 TypeScript tests and four legacy migration-safety tests passed. Updated infrastructure assertions verify the new certificate, hosted zone and CloudFront alias. Live checks passed for HTTPS branding, built assets, geographic/global deep links, western config, API health, room reads, smart zoom, missing-auth rejection, request-header protection, secure renamed guest cookie, authenticated `/me` and missing-location rejection. One guest session was created; no test messages were published. Browser geolocation, email delivery and load testing remain outside these checks.

See [cost estimates](costs.md) for traffic assumptions, growth thresholds and retained-resource costs.

## In-place slots and archive update

The 256-slot revision keeps `PostsV1` and `ControlV1` intact and adds `PostArchiveV1`, exposed through `ArchiveTableName` and the Lambda `ARCHIVE_TABLE_NAME` environment variable. It archives each new post before nine room writes. The archive permits only GetItem/PutItem to the API, and inserts are conditional to prevent overwrites. There is no backfill, propagation or removal of existing posts. Legacy physical slot records are ignored by current reads and remain stored. Browser refreshes now download all current room posts, up to 256. Deploy the backend and frontend together using the normal western-then-edge sequence.

Deployed on 2026-11-13: both stacks completed their in-place updates. The active archive is `GeochalkWest-PostArchiveV1F59FA1E3-YXLKHJ4Z8C65`; it reports ACTIVE, on-demand billing and a `postId` hash key. Lambda reports a successful update with that archive configured. Build and all 35 TypeScript tests passed, covering full 256-post responses, slot distribution, retained originals after eviction/deletion, conditional archive insertion and failure ordering. Live HTTPS/API/config/session/validation checks passed without publishing posts. Existing room/control table names are unchanged, and no backfill was run.
