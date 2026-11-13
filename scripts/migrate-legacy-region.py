"""Historical predecessor tool; not for geochalk v1. Copy schema-v2 records in memory, only between frozen stacks in the pinned account.

Usage: python3 scripts/migrate-legacy-region.py --destination-table TABLE --destination-function FUNCTION --destination-pool POOL
No tokens or record contents are printed or written to disk. Safe to resume a partial copy.
"""
import argparse
import json
import subprocess
import time

ACCOUNT = '451261323611'
SOURCE_REGION = 'us-east-1'
DESTINATION_REGION = 'us-west-2'
SOURCE_TABLE = 'GeohashChat-DataV2EEC63B81-I5V6EOCBZJ4J'
SOURCE_FUNCTION = 'GeohashChat-ApiHandler5E7490E8-r50WUWuKIK70'
SOURCE_POOL = 'us-east-1_P79gzukf1'


def aws(service, operation, region, **payload):
    result = subprocess.run(
        ['aws', service, operation, '--region', region, '--output', 'json',
         '--cli-input-json', 'file:///dev/stdin'],
        input=json.dumps(payload), text=True, capture_output=True,
    )
    if result.returncode:
        # AWS errors can echo request details; intentionally omit their body.
        raise RuntimeError(f'{service} {operation} failed (exit {result.returncode}); no request data logged')
    return json.loads(result.stdout or '{}')


def key(item):
    return item['pk']['S'], item['sk']['S']


def snapshot(region, table):
    records = {}
    kwargs = {'TableName': table, 'ConsistentRead': True}
    while True:
        page = aws('dynamodb', 'scan', region, **kwargs)
        for item in page.get('Items', []):
            # TTL records may disappear during copying. Never omit persistent feed/message records.
            expiry = item.get('expiresAt', {}).get('N')
            if expiry is None or float(expiry) > time.time():
                records[key(item)] = item
        cursor = page.get('LastEvaluatedKey')
        if not cursor:
            return records
        kwargs['ExclusiveStartKey'] = cursor


def require_frozen(region, function, pool, table):
    config = aws('lambda', 'get-function-configuration', region, FunctionName=function)
    env = config.get('Environment', {}).get('Variables', {})
    if env.get('TABLE_NAME') != table or env.get('USER_POOL_ID') != pool:
        raise RuntimeError('Function, table and user pool do not match; refusing migration')
    if env.get('READ_ONLY') != 'true':
        raise RuntimeError(f'{region} API must be read-only before copying')
    if config.get('LastUpdateStatus') != 'Successful':
        raise RuntimeError(f'{region} API update has not completed')
    user_pool = aws('cognito-idp', 'describe-user-pool', region, UserPoolId=pool)['UserPool']
    if not user_pool.get('AdminCreateUserConfig', {}).get('AllowAdminCreateUserOnly'):
        raise RuntimeError(f'{region} signup must be paused before copying')
    users = aws('cognito-idp', 'list-users', region, UserPoolId=pool, Limit=1)
    if users.get('Users'):
        raise RuntimeError('Registered users exist; stop and design account migration before cutover')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination-table', required=True)
    parser.add_argument('--destination-function', required=True)
    parser.add_argument('--destination-pool', required=True)
    args = parser.parse_args()
    if aws('sts', 'get-caller-identity', SOURCE_REGION)['Account'] != ACCOUNT:
        raise RuntimeError('Wrong AWS account; no changes made')
    require_frozen(SOURCE_REGION, SOURCE_FUNCTION, SOURCE_POOL, SOURCE_TABLE)
    require_frozen(DESTINATION_REGION, args.destination_function, args.destination_pool, args.destination_table)
    # Let any requests that started before maintenance mode finish (API timeout is 15 seconds).
    time.sleep(20)
    backup = aws('dynamodb', 'create-backup', SOURCE_REGION, TableName=SOURCE_TABLE,
                 BackupName=f'geohash-before-west-migration-{int(time.time())}')
    backup_arn = backup['BackupDetails']['BackupArn']
    source = snapshot(SOURCE_REGION, SOURCE_TABLE)
    destination = snapshot(DESTINATION_REGION, args.destination_table)
    if any(k not in source or source[k] != value for k, value in destination.items()):
        raise RuntimeError('Destination contains different records; refusing to overwrite')
    pending = [value for k, value in source.items() if k not in destination]
    for index in range(0, len(pending), 25):
        requests = [{'PutRequest': {'Item': item}} for item in pending[index:index + 25]]
        for attempt in range(8):
            response = aws('dynamodb', 'batch-write-item', DESTINATION_REGION,
                           RequestItems={args.destination_table: requests})
            requests = response.get('UnprocessedItems', {}).get(args.destination_table, [])
            if not requests:
                break
            time.sleep(min(2 ** attempt / 10, 5))
        if requests:
            raise RuntimeError('Unprocessed destination writes remain; both APIs must stay frozen')
    current_source = snapshot(SOURCE_REGION, SOURCE_TABLE)
    current_destination = snapshot(DESTINATION_REGION, args.destination_table)
    # Compare only currently unexpired records, because TTL control items can expire mid-copy.
    cutoff = time.time()
    live = lambda records: {k: v for k, v in records.items() if float(v.get('expiresAt', {}).get('N', 'inf')) > cutoff}
    if live(current_source) != live(current_destination):
        raise RuntimeError('Record verification failed; do not cut over')
    status = aws('dynamodb', 'describe-backup', SOURCE_REGION, BackupArn=backup_arn)
    if status['BackupDescription']['BackupDetails']['BackupStatus'] != 'AVAILABLE':
        raise RuntimeError('Backup is not available yet; verify it before cutover')
    print(json.dumps({'verifiedRecords': len(live(current_source)), 'backupArn': backup_arn,
                      'sourcePreserved': True, 'account': ACCOUNT,
                      'destinationRegion': DESTINATION_REGION}))


if __name__ == '__main__':
    main()
