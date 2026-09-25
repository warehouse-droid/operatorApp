"""Exercise cleanup guards with synthetic snapshots; never access production."""
import copy
import importlib.util
import pathlib
import unittest

source = pathlib.Path(__file__).resolve().parents[1] / 'tools/special-workflow-cleanup.py'
spec = importlib.util.spec_from_file_location('special_cleanup', source)
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupSafety(unittest.TestCase):
    def setUp(self):
        self.snapshot = {name: [] for name in cleanup.TABLES}
        self.snapshot.update({
            'request': {'id': 17, 'request_ref': 'SPREQ-000001', 'revision': 2, 'request_type': 'special'},
            'case': {'close_status': 'active', 'sales_order_operation_status': 'idle', 'purchase_order_operation_status': 'idle'},
            'sales_special_stock_lines': [{'id': 1}],
        })

    def test_exact_authorized_enquiry_is_eligible(self):
        cleanup.validate(self.snapshot)

    def test_changed_identity_revision_or_state_is_rejected(self):
        changes = [('request', 'id', 18), ('request', 'request_ref', 'SPREQ-OTHER'),
                   ('request', 'revision', 3), ('request', 'request_type', 'general'),
                   ('case', 'close_status', 'closed')]
        for group, key, value in changes:
            with self.subTest(group=group, key=key):
                snapshot = copy.deepcopy(self.snapshot)
                snapshot[group][key] = value
                with self.assertRaises(ValueError):
                    cleanup.validate(snapshot)

    def test_orders_and_uncertain_operations_are_rejected(self):
        changes = [('sales_order_netsuite_id', 99), ('purchase_order_netsuite_id', 99),
                   ('sales_order_operation_id', 'test-operation'), ('purchase_order_operation_id', 'test-operation'),
                   ('sales_order_operation_status', 'creating'), ('purchase_order_operation_status', 'attention')]
        for key, value in changes:
            with self.subTest(key=key):
                snapshot = copy.deepcopy(self.snapshot)
                snapshot['case'][key] = value
                with self.assertRaises(ValueError):
                    cleanup.validate(snapshot)

    def test_new_dependencies_are_rejected(self):
        for table in ['sales_special_stock_order_lines', 'sales_special_stock_handoffs',
                      'sales_special_stock_media', 'sales_stock_transfers', 'sales_stock_request_lines']:
            with self.subTest(table=table):
                snapshot = copy.deepcopy(self.snapshot)
                snapshot[table] = [{'id': 9}]
                with self.assertRaises(ValueError):
                    cleanup.validate(snapshot)

    def test_missing_request_case_or_changed_line_set_is_rejected(self):
        for field, value in [('request', None), ('case', None), ('sales_special_stock_lines', []),
                             ('sales_special_stock_lines', [{'id': 1}, {'id': 2}])]:
            with self.subTest(field=field, value=value):
                snapshot = copy.deepcopy(self.snapshot)
                snapshot[field] = value
                with self.assertRaises(ValueError):
                    cleanup.validate(snapshot)


if __name__ == '__main__':
    unittest.main(verbosity=2)
