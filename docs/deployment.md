# Deploy to AWS

> Schema v3 is deployed. See [architecture](architecture.md) for the random-slot storage model. The old physical DataV2 tables remain retained; no old data was copied.

Deployment creates billable AWS resources. Use an existing AWS account with an authenticated CLI profile and CDK bootstrap permissions. The repository does not contain credentials. See the verification checklist below for checks beyond infrastructure deployment.

## Active deployment

The application now runs in **AWS account 451261323611, us-west-2**, at **https://geohash.chat**. `GeohashChatWest` owns the active API, Lambda, DynamoDB table, Cognito pool and S3 assets. The `GeohashChat` stack in us-east-1 owns the existing global CloudFront distribution, Route 53 records and required us-east-1 ACM certificate. Its old regional backend remains read-only; it was not deleted.

The user authorized a fresh-data cutover. Eastern records and accounts were not copied. See [region-migration.md](region-migration.md) for the completed cutover and the unused data-preserving procedure.

`infra/app.ts` pins account 451261323611 and rejects a different `CDK_DEFAULT_ACCOUNT`. `cdk.json` persists the western origin identifiers, `eastReadOnly: true`, `westReadOnly: false`, domain and hosted zone `Z08536772NCQUP6FKL46V`. Do not remove these settings or unfreeze the stale eastern backend during ordinary updates.

Before deploying, verify the active CLI identity, then deploy the two stacks explicitly in order:

```sh
aws sts get-caller-identity # Account must be 451261323611
npm ci
npm test
npx cdk diff GeohashChatWest GeohashChat --no-change-set
npx cdk deploy GeohashChatWest --outputs-file cdk-west-outputs.json
npx cdk deploy GeohashChat --outputs-file cdk-outputs.json
```

Both regions are bootstrapped. Each stack pins its own region; changing `AWS_REGION` does not move it. The western stack publishes active assets, and the edge stack's asset deployment triggers CloudFront invalidation when assets/config change. CloudFront remains global; the certificate stays in us-east-1 as AWS requires. The stack does not configure `www` or modify registrar delegation.

S3 remains private with CloudFront Origin Access Control. The western bucket policy grants read access only to the existing distribution. The edge stack imports this bucket, so CDK reports that it cannot update the imported policy; that policy is deliberately managed by the western stack. `/api/*` is uncached and forwards Authorization, cookies and the custom request header. Only `/` and valid geohash paths rewrite to the SPA.

## Schema v3 deployment — 2026-11-11

Caller identity confirmed account **451261323611**. The western stack and edge stack were updated; the active CloudFront API and asset origins remain in us-west-2. The eastern backend remains read-only and does not serve site traffic. Both stacks provisioned their v3 tables; old DataV2 physical tables were retained without migration.

Active western tables:

- Posts: `GeohashChatWest-PostsV3CA088AC3-13H4HESM7PYE2` — TTL disabled.
- Controls: `GeohashChatWest-ControlV33CDFAE28-1O1MIUR5C1FH9` — TTL enabled on `expiresAt`.

Build and 30 TypeScript tests passed before deployment. Live checks passed for HTTPS, deep links, assets, western config, health, room reads, smart zoom, secure HttpOnly guest cookie, authenticated `/me`, invalid-location rejection and request-header protection. No posts were published by smoke checks. Real browser geolocation, successful end-to-end publication/moderation and load tests remain acceptance work.

## Western cutover verification — 2026-11-10

Both stacks completed their updates. CloudFront reports `Deployed` and uses western API and S3 origins. Live checks passed for HTTPS, deep room links, built assets, western production config, API health, room reads, smart zoom, guest creation, authenticated `/me`, missing-auth rejection, missing-location rejection and removal of the old posting endpoint. No chat messages were posted by these checks. Actual browser geolocation and account email delivery remain acceptance checks.

The build and all 30 TypeScript tests plus four migration-safety tests passed during preparation. No source data copy was attempted after the user waived retention.

## Initial eastern deployment verification — 2026-11-10

CloudFormation reached `CREATE_COMPLETE` for `GeohashChat` in account `451261323611`, us-east-1. HTTPS checks passed for the homepage, a room deep link, built JavaScript and production config. Live API health, room reads, smart zoom, guest session creation and authenticated `/me` passed. Posting without authentication returned 401, posting without location returned 400, and the removed room-addressed posting endpoint returned 404. No chat messages were published by these checks.

All 27 automated tests and the production build passed before deployment. The infrastructure test now executes the generated CloudFront routing function to catch escaping errors. Actual browser geolocation, account email delivery, end-to-end valid posting and moderation remain manual/live acceptance checks; the smoke check does not claim to cover them.

The AWS login renewed during deployment changed the CLI **default profile** from its previous account to `451261323611`. Recheck caller identity before using the default profile for other projects.

## Verify after deployment

1. Open `SiteUrl/9q8yy`, grant location and post as a guest. Confirm that the returned posting room is derived from the reported location, even while viewing a distant room. Confirm the post appears in its ancestor feeds but not unrelated or descendant feeds.
2. Refresh, confirm guest identity survives, and test account creation/email confirmation/sign-in. Cognito email quotas and deliverability depend on account configuration; configure SES for production volume.
3. Delete a post and verify it disappears from parent rooms without deleting a replacement in the same slot. Report a message and review it with a moderator account.
4. Test `/` location permission, denial fallback, smart zoom, narrow layouts and keyboard controls.
5. Verify CloudWatch logs/error alarm, DynamoDB point-in-time recovery and access controls. The included alarm has no notification destination; attach an SNS action before launch.

## Moderators

Create and verify an ordinary account, then assign its Cognito username to the group:

```sh
aws cognito-idp admin-add-user-to-group \
  --user-pool-id YOUR_USER_POOL_ID \
  --username YOUR_COGNITO_USERNAME \
  --group-name moderators
```

Sign out and back in to receive a new ID token containing the group. Use that ID token against the moderation API described in [api.md](api.md). Do not place tokens in committed files or log them. Moderators can fetch report pages, delete offending messages and set identity bans. The first milestone does not provide an operator console, report resolution state or audit event stream.

## Operations, retention and cost

Rooms hold at most 1,024 random slots without post TTL. Collisions overwrite full copies independently; there are no canonical bodies or chronological eviction. Control-table TTL expires sessions, counters and coarse observations. Reports, bans and moderation markers have no TTL. Post PITR and retained legacy tables can contain older content. DynamoDB, Cognito and asset buckets retain resources on stack removal.

At five-second polling, one visible tab makes up to 720 requests/hour; each room read retrieves all available slots before sorting and selecting 50. Smart zoom reads up to nine rooms. Broad prefixes and moderation partitions may become hot or expensive. Monitor the storage dashboard (capacity, throttles, latency), configure budgets and alarm notifications, and run load tests. API Gateway throttles at 100 requests/second with a 200 burst; this is not a guaranteed cost ceiling. Source-IP limiting behind CloudFront is a shared backstop, not viewer-IP WAF enforcement.

## Dependency audit

The lockfile pins the installed dependencies. The test runner was updated to remove reported critical advisories. AWS CDK 2.275.0 currently bundles `minimatch` 10.2.6, which npm reports with a moderate denial-of-service advisory (GHSA-g3hv-75wg-m249). This is build/deployment tooling, not included in the browser or API runtime bundle. Do not run `npm audit fix` blindly: in verification it downgraded CDK to an older version with additional high-severity advisories. Recheck upstream CDK releases and the audit before deployment. The current version is explicitly pinned to prevent that automatic downgrade.

## Upgrading to schema v3

This revision creates empty `PostsV3` and `ControlV3` tables. The old `DataV2` table is retained. No posts, sessions, reports or bans are automatically copied. Existing guest bearer identities will become new cookie identities. Review the diff and coordinate backend/frontend rollout; downtime is allowed for the planned fresh-data update. The commands above describe the coordinated deployment sequence.

After deploying the western stack, update `cdk.json`'s `backendTarget.tableName` from its new `TableName` output before deploying the edge stack. Record `ControlTableName` separately for operations. Preserve the existing API, bucket, pool, account and region identifiers unless the actual outputs change. Historical v2 migration scripts must not copy old records into v3 tables.

Before launch, exercise permission denial, stale/future fixes, low accuracy, geographic jumps, guest-cookie persistence, browsing elsewhere while posting, random collisions, delayed writes, partial fanout and conditional moderation deletion. Do not enable request-body logging containing coordinates. This task's tests mock AWS calls; real DynamoDB contention, browser/device location, account email delivery and load/cost tests remain deployment acceptance work.
