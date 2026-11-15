"""Packaging and local publication tests; never contact a real GitHub account."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('release_tools', ROOT / 'scripts/release_tools.py')
TOOLS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOLS)
REAL_GIT = shutil.which('git')
URL = 'https://github.com/yanjing-chen/popup-llm-officeassistent.git'


class DistributionTests(unittest.TestCase):
    def test_complete_source_and_precompiled_archive(self):
        with tempfile.TemporaryDirectory(prefix='popup-package-test-') as name:
            output = Path(name)
            copy_zip, source_zip = TOOLS.build(output, 'v2.2.4')
            with zipfile.ZipFile(copy_zip) as archive:
                self.assertIn(TOOLS.UUID + '/schemas/gschemas.compiled', archive.namelist())
                self.assertIn(TOOLS.UUID + '/extension.js', archive.namelist())
                self.assertIn('install.sh', archive.namelist())
                self.assertFalse(any(path.startswith(('tests/', 'scripts/', '.github/')) for path in archive.namelist()))
                archive.extractall(output / 'copy')
            with zipfile.ZipFile(source_zip) as archive:
                for required in ['.github/workflows/release.yml', '.gitignore', 'scripts/publish_from_6800h.sh',
                                 'tests/test_distribution.py', TOOLS.UUID + '/resultWindow.js']:
                    self.assertIn(required, archive.namelist())
                self.assertFalse(any('/.git/' in path or path.startswith('dist/') for path in archive.namelist()))
            result = subprocess.run(['sha256sum', '--check', 'CHECKSUMS.sha256'], cwd=output / 'copy',
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    @unittest.skipIf(os.getuid() == 0, 'installer intentionally rejects root')
    def test_release_installs_without_calling_compiler(self):
        with tempfile.TemporaryDirectory(prefix='popup-no-compile-test-') as name:
            root = Path(name)
            copy_zip, _ = TOOLS.build(root)
            package = root / 'package'
            with zipfile.ZipFile(copy_zip) as archive:
                archive.extractall(package)
            tools = root / 'fake-tools'
            tools.mkdir()
            (tools / 'glib-compile-schemas').write_text('#!/bin/sh\necho COMPILER_MUST_NOT_RUN >&2\nexit 97\n')
            (tools / 'glib-compile-schemas').chmod(0o755)
            (tools / 'gnome-extensions').write_text('#!/bin/sh\nexit 0\n')
            (tools / 'gnome-extensions').chmod(0o755)
            data = root / 'isolated-data'
            result = subprocess.run(['bash', str(package / 'install.sh')], capture_output=True, text=True,
                env={**os.environ, 'XDG_DATA_HOME': str(data), 'GSETTINGS_BACKEND': 'memory',
                     'PATH': str(tools) + os.pathsep + os.environ['PATH']})
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertNotIn('COMPILER_MUST_NOT_RUN', result.stderr)
            self.assertIn('本次未执行编译', result.stdout)
            self.assertEqual((data / 'gnome-shell/extensions' / TOOLS.UUID / 'schemas/gschemas.compiled').read_bytes(),
                             (package / TOOLS.UUID / 'schemas/gschemas.compiled').read_bytes())

    def test_tag_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='popup-wrong-tag-') as name:
            with self.assertRaisesRegex(ValueError, 'does not match'):
                TOOLS.build(Path(name), 'v9.9.9')
            self.assertEqual(list(Path(name).iterdir()), [])

    @unittest.skipIf(os.getuid() == 0, 'installer intentionally rejects root')
    def test_readme_download_install_commands_with_isolated_fake_downloads(self):
        import re
        block = re.search(r'```bash\n(\(\n  set -e\n[\s\S]*?)\n```', (ROOT / 'README.md').read_text()).group(1)
        with tempfile.TemporaryDirectory(prefix='popup-readme-test-') as name:
            base = Path(name)
            assets = base / 'assets'
            TOOLS.build(assets)
            tools = base / 'fake-tools'
            tools.mkdir()
            curl = tools / 'curl'
            curl.write_text('''#!/usr/bin/env python3
import os, pathlib, shutil, sys
a = sys.argv[1:]
output = a[a.index('--output') + 1]
url = next(x for x in a if x.startswith('https://'))
asset = url.rsplit('/', 1)[-1]
if asset not in ['popup-llm-officeassistent-precompiled.zip', 'SHA256SUMS']: sys.exit(3)
shutil.copyfile(pathlib.Path(os.environ['TEST_ASSETS'], asset), output)
''')
            curl.chmod(0o755)
            (tools / 'gnome-extensions').write_text('#!/bin/sh\nexit 0\n')
            (tools / 'gnome-extensions').chmod(0o755)
            result = subprocess.run(['bash', '-c', block], capture_output=True, text=True,
                env={**os.environ, 'TMPDIR': str(base), 'XDG_DATA_HOME': str(base / 'data'),
                     'GSETTINGS_BACKEND': 'memory', 'TEST_ASSETS': str(assets),
                     'PATH': str(tools) + os.pathsep + os.environ['PATH']})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('本次未执行编译', result.stdout)

    def test_packaging_does_not_modify_source_schema(self):
        schema = ROOT / TOOLS.UUID / 'schemas/gschemas.compiled'
        before = schema.read_bytes()
        with tempfile.TemporaryDirectory(prefix='popup-stable-schema-') as name:
            TOOLS.build(Path(name))
        self.assertEqual(before, schema.read_bytes())

    def test_workflow_only_publishes_tags_after_successful_build(self):
        workflow = (ROOT / '.github/workflows/release.yml').read_text()
        self.assertIn('permissions:\n  contents: read', workflow)
        self.assertIn("if: startsWith(github.ref, 'refs/tags/v')", workflow)
        self.assertIn('needs: build', workflow)
        self.assertIn('--verify-tag --latest', workflow)
        self.assertNotIn('--clobber', workflow)


@unittest.skipUnless(REAL_GIT, 'Git is required for isolated publication tests')
class LocalPublishTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='popup-local-publish-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
        self.remote = self.root / 'remote.git'
        self.git('init', '--bare', '--initial-branch=main', str(self.remote))
        self.source = self.root / 'complete-source'
        shutil.copytree(ROOT, self.source, ignore=shutil.ignore_patterns('.git', 'dist', '__pycache__', '*.pyc'))
        # Avoid recursively invoking this test suite from its own fixture.
        (self.source / 'verify.sh').write_text('#!/bin/bash\nset -e\npython3 scripts/release_tools.py checksums --check\n')
        subprocess.run([sys.executable, str(self.source / 'scripts/release_tools.py'), 'checksums'], check=True)
        self.bin = self.root / 'fake-tools'
        self.bin.mkdir()
        gh = self.bin / 'gh'
        gh.write_text('''#!/usr/bin/env python3
import os, sys
a = sys.argv[1:]
if a[:2] == ['auth', 'status']: sys.exit(0)
if a[:2] == ['api', 'user']: print(os.environ.get('TEST_ACCOUNT', 'yanjing-chen')); sys.exit(0)
if a[:2] == ['repo', 'view']:
    print('yanjing-chen/popup-llm-officeassistent\\tADMIN\\tPRIVATE'); sys.exit(0)
raise SystemExit('Unexpected GitHub command: ' + repr(a))
''')
        gh.chmod(0o755)
        wrapper = self.bin / 'git'
        wrapper.write_text('''#!/usr/bin/env python3
import os, pathlib, subprocess, sys, tempfile
a = [os.environ['TEST_REMOTE'] if x == os.environ['TEST_URL'] else x for x in sys.argv[1:]]
real = os.environ['TEST_REAL_GIT']
if 'push' in a and os.environ.get('TEST_REJECT_PUSH') == '1': sys.exit(1)
if 'push' in a and os.environ.get('TEST_ADVANCE_MAIN') == '1':
    with tempfile.TemporaryDirectory(prefix='popup-race-') as d:
        subprocess.run([real, 'clone', os.environ['TEST_REMOTE'], d], check=True, capture_output=True)
        for k, v in [('user.name', 'Concurrent test'), ('user.email', 'test@example.invalid')]:
            subprocess.run([real, '-C', d, 'config', k, v], check=True)
        pathlib.Path(d, 'concurrent.txt').write_text('preserve this commit')
        subprocess.run([real, '-C', d, 'add', '--all'], check=True)
        subprocess.run([real, '-C', d, 'commit', '-m', 'Concurrent update'], check=True, capture_output=True)
        subprocess.run([real, '-C', d, 'push', 'origin', 'main'], check=True, capture_output=True)
os.execv(real, [real, *a])
''')
        wrapper.chmod(0o755)
        self.env.update({'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
                         'TEST_REMOTE': str(self.remote), 'TEST_URL': URL, 'TEST_REAL_GIT': REAL_GIT})

    def git(self, *args, check=True):
        return subprocess.run([REAL_GIT, *args], env=self.env, capture_output=True, text=True, check=check)

    def seed(self, extra=False, tagged=False):
        seed = self.root / 'seed'
        self.git('clone', str(self.remote), str(seed))
        self.git('-C', str(seed), 'config', 'user.name', 'Seed test')
        self.git('-C', str(seed), 'config', 'user.email', 'test@example.invalid')
        if extra:
            (seed / 'unrelated.txt').write_text('do not overwrite or delete')
            self.git('-C', str(seed), 'add', '--all')
        self.git('-C', str(seed), 'commit', '--allow-empty', '-m', 'Cleared main')
        self.git('-C', str(seed), 'push', 'origin', 'main')
        if tagged:
            self.git('-C', str(seed), 'tag', 'v2.2.4')
            self.git('-C', str(seed), 'push', 'origin', 'v2.2.4')
        return self.git('--git-dir', str(self.remote), 'rev-parse', 'main').stdout.strip()

    def publish(self, **extra):
        parent = self.root / 'new-worktrees'
        parent.mkdir(exist_ok=True)
        return subprocess.run(['bash', str(self.source / 'scripts/publish_from_6800h.sh'), str(parent)],
                              env={**self.env, **extra}, capture_output=True, text=True)

    def test_preserves_cleared_main_history_and_pushes_source_and_tag(self):
        original = self.seed()
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.git('--git-dir', str(self.remote), 'merge-base', '--is-ancestor', original, 'main')
        self.assertEqual(self.git('--git-dir', str(self.remote), 'rev-list', '--count', 'main').stdout.strip(), '2')
        self.assertEqual(self.git('--git-dir', str(self.remote), 'rev-parse', 'main').stdout,
                         self.git('--git-dir', str(self.remote), 'rev-parse', 'v2.2.4^{}').stdout)
        files = self.git('--git-dir', str(self.remote), 'ls-tree', '-r', '--name-only', 'main').stdout
        self.assertIn('.github/workflows/release.yml', files)
        self.assertIn(TOOLS.UUID + '/schemas/gschemas.compiled', files)
        self.assertNotIn('dist/', files)
        self.assertIn('PRIVATE（保持不变）', result.stdout)

    def test_can_initialize_a_truly_empty_repository(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(self.git('--git-dir', str(self.remote), 'rev-list', '--count', 'main').stdout.strip(), '1')

    def test_extra_remote_files_stop_publication_without_deletion(self):
        original = self.seed(extra=True)
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('additional files', result.stderr)
        self.assertEqual(self.git('--git-dir', str(self.remote), 'rev-parse', 'main').stdout.strip(), original)
        self.assertEqual(self.git('--git-dir', str(self.remote), 'show', 'main:unrelated.txt').stdout, 'do not overwrite or delete')
        self.assertEqual(self.git('--git-dir', str(self.remote), 'tag').stdout, '')

    def test_existing_tag_is_not_moved(self):
        original = self.seed(tagged=True)
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git('--git-dir', str(self.remote), 'rev-parse', 'v2.2.4').stdout.strip(), original)
        self.assertEqual(self.git('--git-dir', str(self.remote), 'rev-parse', 'main').stdout.strip(), original)

    def test_permission_rejection_does_not_trigger_force_retry(self):
        original = self.seed()
        result = self.publish(TEST_REJECT_PUSH='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('发布已停止', result.stderr)
        self.assertEqual(self.git('--git-dir', str(self.remote), 'rev-parse', 'main').stdout.strip(), original)
        self.assertEqual(self.git('--git-dir', str(self.remote), 'tag').stdout, '')

    def test_atomic_push_does_not_publish_tag_if_main_advanced(self):
        self.seed()
        result = self.publish(TEST_ADVANCE_MAIN='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git('--git-dir', str(self.remote), 'tag').stdout, '')
        self.assertIn('concurrent.txt', self.git('--git-dir', str(self.remote), 'ls-tree', '-r', '--name-only', 'main').stdout)

    def test_wrong_account_stops_before_clone_or_push(self):
        original = self.seed()
        result = self.publish(TEST_ACCOUNT='someone-else')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list((self.root / 'new-worktrees').iterdir()), [])
        self.assertEqual(self.git('--git-dir', str(self.remote), 'rev-parse', 'main').stdout.strip(), original)


if __name__ == '__main__':
    unittest.main()
