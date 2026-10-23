"""Exercise the shipping argument parser without running installer authority."""
import os
from pathlib import Path
import subprocess
import unittest
INSTALLER = Path(__file__).resolve().parents[1] / 'install.sh'


def parse(*args):
    return subprocess.run(['bash', '-c', 'source "$1"; shift; parse_args "$@"; printf "commission=%s agents=%s\\n" "$COMMISSION_SHARED_BROWSER" "${#SHARED_BROWSER_AGENTS[@]}"', 'parser', str(INSTALLER), *args],
                          env={**os.environ, 'BRIDGESLLM_INSTALLER_SOURCE_ONLY': '1'}, capture_output=True, text=True)


class Arguments(unittest.TestCase):
    def test_explicit_owner_and_agents_only(self):
        result = parse('--commission-shared-browser', '--shared-browser-owner', '00000000-0000-0000-0000-000000000001', '--shared-browser-agent', 'alpha', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('commission=true agents=1', result.stdout)
    def test_ordinary_update_does_not_commission(self):
        result = parse('--update', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('commission=false agents=0', result.stdout)
    def test_mixed_and_incomplete_operations_refused(self):
        base = ['--commission-shared-browser', '--shared-browser-owner', '00000000-0000-0000-0000-000000000001', '--shared-browser-agent', 'alpha']
        for extra in ['--install', '--update', '--repair', '--maintain-tools', '--skip-openclaw', '--uninstall']:
            self.assertNotEqual(parse(*base, extra).returncode, 0, extra)
        self.assertNotEqual(parse('--shared-browser-owner', 'anything').returncode, 0)
        self.assertNotEqual(parse('--commission-shared-browser').returncode, 0)
        self.assertNotEqual(parse('--commission-shared-browser', '--shared-browser-owner').returncode, 0)


if __name__ == '__main__': unittest.main()
