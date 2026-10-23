#!/usr/bin/env python3
import copy
import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('composer', Path(__file__).parents[1] / 'shared-browser-config.py')
composer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(composer)
PLUGIN = '/usr/local/lib/bridges-shared-browser/plugin'
def product():
    return {'agents': {'ownership': 'explicit', 'entries': {'alpha': {'tools': {'allow': ['read'], 'deny': ['exec']}},
                                                            'beta': {'tools': {'profile': 'coding'}}, 'other': {}}},
            'browser': {'profiles': {'everyday': {'cdpPort': 18803}}},
            'plugins': {'allow': ['codex'], 'load': {'paths': ['/opt/other-plugin']}}}
class Configuration(unittest.TestCase):
    def test_patch_is_additive_and_keyed_by_entries(self):
        config = product()
        original = copy.deepcopy(config)
        patch = composer.compose(config, ['alpha', 'beta'], PLUGIN)
        self.assertEqual(config, original)
        self.assertEqual(patch['browser']['profiles'], {'portal-shared': {'cdpUrl': 'http://127.0.0.1:18901', 'attachOnly': True}})
        self.assertFalse(patch['browser']['allowSystemProfileImport'])
        self.assertEqual(patch['gateway']['nodes']['browser']['mode'], 'off')
        self.assertEqual(patch['plugins']['load']['paths'], ['/opt/other-plugin', PLUGIN])
        self.assertEqual(patch['plugins']['allow'], ['codex', 'browser', 'bridgesllm-shared-browser'])
        self.assertEqual(patch['plugins']['entries'], {'bridgesllm-shared-browser': {'enabled': True, 'config': {'agentIds': ['alpha', 'beta']}}})
        self.assertEqual(patch['agents']['entries']['alpha'], {'tools': {'allow': ['read', 'browser', 'shared_browser_select', 'shared_browser_handover']}})
        self.assertEqual(patch['agents']['entries']['beta'], {'tools': {'alsoAllow': ['browser', 'shared_browser_select', 'shared_browser_handover']}})
        self.assertNotIn('other', patch['agents']['entries'])
        self.assertNotIn('list', patch['agents'])
        result = composer.merged(config, patch)
        self.assertEqual(result['agents']['entries']['alpha']['tools']['deny'], ['exec'])
        self.assertEqual(result['agents']['entries']['beta']['tools']['profile'], 'coding')
        self.assertEqual(result['browser']['profiles']['everyday'], {'cdpPort': 18803})
        self.assertTrue(composer.commissioned(result, ['alpha', 'beta'], PLUGIN))
        self.assertFalse(composer.commissioned(config, ['alpha', 'beta'], PLUGIN))
        self.assertEqual(composer.merged(result, composer.compose(result, ['alpha', 'beta'], PLUGIN)), result)
    def test_missing_legacy_conflicting_or_denied_shapes_are_not_guessed(self):
        def variant(change):
            config = product(); change(config); return config
        cases = [
            ({}, ['alpha']),
            (product(), []),
            (product(), ['alpha', 'alpha']),
            (product(), ['absent']),
            ({'agents': {'list': [{'id': 'alpha'}], 'entries': {'alpha': {}}}}, ['alpha']),
            (variant(lambda c: c['browser']['profiles'].update({'portal-shared': {'cdpPort': 18801}})), ['alpha']),
            (variant(lambda c: c['browser']['profiles'].update({'legacy': {'cdpUrl': 'http://127.0.0.1:18901'}})), ['alpha']),
            (variant(lambda c: c['browser'].update({'enabled': False})), ['alpha']),
            (variant(lambda c: c['plugins'].update({'enabled': False})), ['alpha']),
            (variant(lambda c: c['plugins'].update({'deny': ['browser']})), ['alpha']),
            (variant(lambda c: c.update({'tools': {'deny': ['browser']}})), ['beta']),
            (variant(lambda c: c['agents']['entries']['beta']['tools'].update({'deny': ['shared_browser_select']})), ['beta']),
        ]
        for config, ids in cases:
            with self.assertRaises(ValueError): composer.compose(config, ids, PLUGIN)
        with self.assertRaises(ValueError): composer.compose(product(), ['alpha'], 'relative/plugin')
if __name__ == '__main__': unittest.main()
