# Deploy to AWS

Deployment creates billable AWS resources. Use an existing AWS account with an authenticated CLI profile and CDK bootstrap permissions. The repository does not contain credentials. The implementation has been prepared locally; verify the deployment in a non-production account/stage before public launch.

## Default CloudFront domain

```sh
npm ci
npm test
npm run build
export AWS_PROFILE=your-profile
export AWS_REGION=us-east-1
export CDK_DEFAULT_REGION=us-east-1
aws sts get-caller-identity
npx cdk bootstrap aws://YOUR_ACCOUNT_ID/us-east-1
npm run synth
npx cdk diff
npm run deploy
```

The stack outputs `SiteUrl`, `UserPoolId`, `UserPoolClientId`, and `TableName`; deployment writes them to ignored `cdk-outputs.json`. The default stack uses a generated CloudFront domain and does not modify DNS. CloudFront deployment/invalidation and Cognito provisioning can take several minutes. The AWS account must support the configured 50 reserved Lambda concurrency (reduce this setting for accounts with low quotas).

## geohash.chat with Route 53

The hosted zone must already exist in the deployment account, and its nameservers must be delegated by the registrar. Use `us-east-1` for this single-stack deployment because CloudFront certificates must be there. Set the context flags on every subsequent synth/diff/deploy for that stack.

```sh
npm run build
npx cdk diff -c domain=geohash.chat -c hostedZoneId=YOUR_ZONE_ID
npx cdk deploy -c domain=geohash.chat -c hostedZoneId=YOUR_ZONE_ID --outputs-file cdk-outputs.json
```

If `hostedZoneId` is omitted, CDK performs a Route 53 lookup by domain name. The stack creates DNS validation records, the ACM certificate and apex A/AAAA CloudFront aliases. It does not manage a registrar or configure `www`. Check for existing apex records before deploying. Reusing a zone with active production records requires an intentional DNS migration.

Static assets live in a private S3 bucket accessible through CloudFront Origin Access Control. `/api/*` proxies to the HTTP API without caching; Authorization is forwarded. Only `/` and valid geohash paths rewrite to the SPA. Other missing assets keep their error response. `/config.json` is generated with deployed Cognito identifiers, and publishing invalidates CloudFront. Browser assets currently use `no-cache`; optimize hashed asset cache headers later if needed.

## Verify after deployment

1. Open `SiteUrl/9q8yy`, grant location and post as a guest. Confirm that the returned posting room is derived from the reported location, even while viewing a distant room. Confirm the post appears in its ancestor feeds but not unrelated or descendant feeds.
2. Refresh, confirm guest identity survives, and test account creation/email confirmation/sign-in. Cognito email quotas and deliverability depend on account configuration; configure SES for production volume.
3. Delete a message and verify tombstones in parent rooms. Report a message and review it with a moderator account.
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

Room feeds retain their newest 1,000 posts independently with no TTL. Eviction deletes only that room’s projection and removes canonical content after the last projection is gone. Reports and ban records have no TTL. Expiring sessions, rate limits, receipts and activity use TTL plus explicit time checks where required. DynamoDB and Cognito use retain removal policies; the asset bucket is also retained. `cdk destroy` will not delete those retained resources or their data. Plan and verify backups, recovery and eventual cleanup explicitly.

HTTP polling produces reads even when a room is quiet: at five seconds, one visible tab makes up to 720 requests/hour. Low-precision rooms and activity counters can become hot partitions. Configure budgets, monitor throttling and transaction conflicts, run load tests, and add operational abuse controls before public launch. API Gateway throttles at 100 requests/second with a 200 burst; this is a safeguard, not a guaranteed cost ceiling. The API URL is reachable directly, and source-IP rate limiting behind CloudFront is not viewer-IP WAF enforcement.

## Dependency audit

The lockfile pins the installed dependencies. The test runner was updated to remove reported critical advisories. AWS CDK 2.275.0 currently bundles `minimatch` 10.2.6, which npm reports with a moderate denial-of-service advisory (GHSA-g3hv-75wg-m249). This is build/deployment tooling, not included in the browser or API runtime bundle. Do not run `npm audit fix` blindly: in verification it downgraded CDK to an older version with additional high-severity advisories. Recheck upstream CDK releases and the audit before deployment. The current version is explicitly pinned to prevent that automatic downgrade.

## Upgrading from schema v1

This release replaces client-chosen posting rooms and unbounded room history. `DataV2` is a new CDK table resource; deployment switches the API to a new empty table and retains the old table. No previous data is automatically copied. Review `cdk diff` before deploying this change to any existing stack. Do not assume old sessions, reports, bans or posts have migrated.

If existing v1 data must be preserved, freeze writes and export/backup v1 first. Prepare an offline migration that selects each room’s newest 1,000 projections, writes its sorted `FEED` key list/revision, reconstructs canonical `retainedRooms`/revision from surviving copies, and imports required control records. Validate counts, memberships and deletion behavior before switching traffic. This repository does not include a v1 migration executor; the original local implementation had not been deployed. Never point the new writer at unmodified v1 records.

Before launch, test location denial, stale/future timestamps, desktop accuracy and latitude edge cases. Browse a distant room while posting and verify the destination cannot be overridden with URL/body fields. Use controlled test clients to validate the 1,000/1,001 boundary, independent parent/child retention, concurrent posts and eviction/deletion races. Do not enable API body logs containing coordinates. The room metadata list trades write cost and coarse-room contention for exact count retention; benchmark before high traffic.
