import contextlib
import copy
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('migration', Path(__file__).parents[1] / 'scripts/migrate-region.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.source = [{'pk': {'S': 'MESSAGE#test'}, 'sk': {'S': 'META'}, 'message': {'S': 'private test content'}}]
        self.target = []
        self.calls = []
        self.account = migration.ACCOUNT
        self.frozen = True
        self.user_exists = False
        self.defer_write = True

    def aws(self, service, operation, region, **payload):
        self.calls.append((service, operation))
        if operation == 'get-caller-identity':
            return {'Account': self.account}
        if operation == 'get-function-configuration':
            source = region == migration.SOURCE_REGION
            return {'LastUpdateStatus': 'Successful', 'Environment': {'Variables': {
                'READ_ONLY': 'true' if self.frozen else 'false',
                'TABLE_NAME': migration.SOURCE_TABLE if source else 'west-table',
                'USER_POOL_ID': migration.SOURCE_POOL if source else 'west-pool',
            }}}
        if operation == 'describe-user-pool':
            return {'UserPool': {'AdminCreateUserConfig': {'AllowAdminCreateUserOnly': True}}}
        if operation == 'list-users':
            return {'Users': [{'Username': 'existing'}] if self.user_exists else []}
        if operation == 'create-backup':
            return {'BackupDetails': {'BackupArn': 'backup-arn'}}
        if operation == 'describe-backup':
            return {'BackupDescription': {'BackupDetails': {'BackupStatus': 'AVAILABLE'}}}
        if operation == 'scan':
            return {'Items': copy.deepcopy(self.source if region == migration.SOURCE_REGION else self.target)}
        if operation == 'batch-write-item':
            if self.defer_write:
                self.defer_write = False
                return {'UnprocessedItems': payload['RequestItems']}
            self.target.extend(copy.deepcopy([r['PutRequest']['Item'] for r in payload['RequestItems']['west-table']]))
            return {}
        raise AssertionError(operation)

    def run_copy(self):
        output = io.StringIO()
        with patch.object(migration, 'aws', side_effect=self.aws), patch.object(migration.time, 'sleep'), patch('sys.argv', ['migrate-region.py', '--destination-table', 'west-table', '--destination-function', 'west-function', '--destination-pool', 'west-pool']), contextlib.redirect_stdout(output):
            migration.main()
        return output.getvalue()

    def test_wrong_account_stops_before_changes(self):
        self.account = '000000000000'
        with self.assertRaisesRegex(RuntimeError, 'Wrong AWS account'):
            self.run_copy()
        self.assertEqual(self.calls, [('sts', 'get-caller-identity')])

    def test_live_writes_or_registered_users_stop_migration(self):
        self.frozen = False
        with self.assertRaisesRegex(RuntimeError, 'read-only'):
            self.run_copy()
        self.frozen = True
        self.user_exists = True
        with self.assertRaisesRegex(RuntimeError, 'Registered users'):
            self.run_copy()
        self.assertNotIn(('dynamodb', 'batch-write-item'), self.calls)

    def test_destination_conflict_is_never_overwritten(self):
        self.target = [{'pk': {'S': 'different'}, 'sk': {'S': 'META'}}]
        original = copy.deepcopy(self.target)
        with self.assertRaisesRegex(RuntimeError, 'refusing to overwrite'):
            self.run_copy()
        self.assertEqual(self.target, original)

    def test_copy_retries_unprocessed_records_verifies_and_does_not_log_content(self):
        original = copy.deepcopy(self.source)
        output = self.run_copy()
        self.assertEqual(self.source, original)
        self.assertEqual(self.target, original)
        self.assertNotIn('private test content', output)
        self.assertIn('"verifiedRecords": 1', output)
        # A completed copy is safe to resume without duplicate or conflicting writes.
        self.run_copy()
        self.assertEqual(self.target, original)


if __name__ == '__main__':
    unittest.main()
