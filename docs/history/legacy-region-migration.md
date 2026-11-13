> Historical record of the predecessor deployment. Resource names and schema versions below are intentionally unchanged. For geochalk, use [the current deployment guide](../deployment.md).

# Move geohash.chat to us-west-2

> Schema v3 local update: see [architecture](../architecture.md). The random-slot revision is now deployed. Existing DataV2 migration/copy steps below describe historical schema v2 and are not a v3 data conversion. The coordinated deployment created PostsV3/ControlV3, retained the old physical tables, and refreshed the recorded backend table output.

## Completed cutover — 2026-11-10

The cutover to **us-west-2** is complete in verified account **451261323611**. The user explicitly waived data migration and continuity requirements. No database copy or migration backup was performed; the active application uses the new western database and user pool. Existing eastern data was not migrated or deleted.

`GeohashChatWest` is writable and signup is enabled. The original `GeohashChat` stack keeps the global CloudFront distribution `E17G6J5BI86OTG`, DNS and the ACM certificate in us-east-1. Its legacy regional backend is read-only and its self-signup is disabled. No CLI login/profile changes were made during this cutover.

Verified CloudFront status is `Deployed`, with these origins:

- API: `ymhbg71uhi.execute-api.us-west-2.amazonaws.com`
- Assets: `geohashchatwest-webassets27872646-6guc1kzkq0jh.s3.us-west-2.amazonaws.com`

Live HTTPS, deep links, production config, API health, room reads, activity suggestions, guest creation and authenticated reads passed. Unauthorized posting and location-less posting were rejected, and the removed room-posting route returned 404. No test chat messages were published. Existing eastern guest tokens will expire from the active app's perspective and clients can create a new western guest session.

The procedure below documents the **data-preserving alternative**, which was prepared and tested but not used. The source/target no longer have matching data, so do not run its copy steps against the now-active destination. The copy script refuses to run while the western API is writable.

## Prepare the destination

```sh
aws sts get-caller-identity # must be 451261323611
npx cdk bootstrap aws://451261323611/us-west-2
npm test
python3 -m unittest discover -s test -p 'test_migration.py'
npx cdk diff GeohashChatWest --no-change-set -c enableWest=true -c westReadOnly=true
npx cdk deploy GeohashChatWest -c enableWest=true -c westReadOnly=true --outputs-file cdk-west-outputs.json
```

Record the returned API ID, table, bucket, pool, client and Lambda function names. Do not change `backendTarget` yet. Check the direct western API: GET health should succeed, and mutations should return 503 while frozen. S3 is private and grants read access only to the existing distribution.

## Freeze and copy (requires agreed maintenance window)

1. Persist `enableWest: true`, `eastReadOnly: true`, `westReadOnly: true` in `cdk.json` context. Preserve `domain` and `hostedZoneId` and leave `backendTarget` absent until verified.
2. Deploy **only** `GeohashChat` and wait for completion. Verify the live domain still serves room reads and rejects mutations with 503. Cognito self-signup must be disabled; existing accounts must still number zero. Both regional APIs must be frozen.
3. Run the copy script with the destination identifiers from stack outputs:

```sh
python3 scripts/migrate-legacy-region.py \
  --destination-table WEST_TABLE \
  --destination-function WEST_FUNCTION \
  --destination-pool WEST_POOL
```

The script verifies account, function/table/pool alignment, maintenance state and absence of registered users. It waits for in-flight requests, creates a source backup, copies records in memory using AWS CLI stdin, retries unprocessed writes, and compares source/destination records before reporting success. It does not print or write message/session contents or credentials to disk. Expired TTL control records are excluded; persistent posts and feed records are preserved. Conflicting destination data stops the process without overwriting it. The source remains intact. Keep both APIs frozen on any error.

## Switch traffic

1. After verified copying, add `backendTarget` in `cdk.json` with `region: "us-west-2"`, `apiId`, `bucketName`, `tableName`, `userPoolId` and `userPoolClientId` from western outputs.
2. Deploy **only** the east `GeohashChat` edge stack while both backends remain read-only. Review the diff: origins/config/outputs should update; existing CDN, certificate, DNS and legacy data must not be replaced or removed.
3. Wait for CloudFront deployment and invalidation. Verify the public config reports us-west-2, GET routes work, and the distribution origins point to the western API and bucket.
4. Set `westReadOnly: false` and deploy **only** `GeohashChatWest`. Keep `eastReadOnly: true`. Verify guest creation/authenticated reads and validation errors. Do not publish test messages without authorization.

The maintenance window covers these deployments, usually several minutes; do not promise an exact duration. The existing guest tokens work because their hashed session records are copied. Registered users are handled only by refusing the move if any exist. New registrations use the western pool after reopening.

## Recovery

Before reopening western writes, remove `backendTarget` and redeploy the edge if cutover fails, then explicitly unfreeze the east stack; its source data was preserved. Once western writes have been accepted, do **not** simply switch back to the stale eastern table. Freeze both backends and reconcile/copy the western changes before rollback. No automatic post-cutover rollback or legacy cleanup is implemented. Do not delete either stack or retained table as part of recovery without a reviewed data-preservation plan.

## Subsequent updates

Once migration is complete, deploy the explicit stack names rather than relying on a default selection. `GeohashChatWest` is the active application; `GeohashChat` owns the global edge and frozen legacy resources. Recheck account identity before any AWS command. This procedure does not change CLI login profiles.
