import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
spec = importlib.util.spec_from_file_location('owner', Path(__file__).parents[1] / 'shared-browser-owner.py')
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
A = '00000000-0000-0000-0000-000000000001'
B = '00000000-0000-0000-0000-000000000002'

@unittest.skipUnless(os.geteuid() == 0, 'production custody requires root')
class Ownership(unittest.TestCase):
    def test_pin_survives_release_and_refuses_reassignment(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state'; state.mkdir(mode=0o700)
            profile = Path(tmp) / 'profile'
            owner.pin(A, state, profile)
            profile.mkdir(); (profile / 'Cookies').write_bytes(b'owned-cookie-fixture')
            owner.pin(A, state, profile)
            with self.assertRaisesRegex(ValueError, 'Owner differs'): owner.pin(B, state, profile)
            self.assertEqual((profile / 'Cookies').read_bytes(), b'owned-cookie-fixture')
    def test_unowned_cookies_and_symlink_pin_cannot_be_adopted(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state'; state.mkdir(mode=0o700)
            profile = Path(tmp) / 'profile'; profile.mkdir(); (profile / 'Cookies').touch()
            with self.assertRaisesRegex(ValueError, 'Unowned profile'): owner.pin(A, state, profile)
            (state / 'profile-owner.json').symlink_to(Path(tmp) / 'absent')
            with self.assertRaises(OSError): owner.pin(A, state, profile)
    def test_unsafe_directory_and_file_custody_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state'; state.mkdir(mode=0o755)
            with self.assertRaisesRegex(ValueError, 'directory'): owner.pin(A, state, Path(tmp) / 'profile')
            state.chmod(0o700); owner.pin(A, state, Path(tmp) / 'profile')
            (state / 'profile-owner.json').chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'file'): owner.pin(A, state, Path(tmp) / 'profile')

if __name__ == '__main__': unittest.main()
