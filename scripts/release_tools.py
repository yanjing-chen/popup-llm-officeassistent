#!/usr/bin/env python3
"""Standard-library-only integrity, packaging and safe staging helpers."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
UUID = 'popup-llm-officeassistent@yanjing_chen@qq.com'
SCHEMA = 'org.gnome.shell.extensions.popup-llm-officeassistent'
COPY_ASSET = 'popup-llm-officeassistent-precompiled.zip'
ROOT_FILES = ('.gitignore', '.gitattributes', 'README.md', 'RELEASE_NOTES.md',
              'install.sh', 'verify.sh', 'diagnose-selection.sh', 'diagnose-ocr.sh')
SOURCE_DIRS = (UUID, 'tests', 'scripts', 'docs', '.github/workflows')


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sources(root: Path) -> list[str]:
    paths = []
    for name in ROOT_FILES:
        path = root / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f'Missing or unsafe source file: {name}')
        paths.append(name)
    for directory in SOURCE_DIRS:
        for path in (root / directory).rglob('*'):
            if '__pycache__' in path.parts or path.suffix in ('.pyc', '.pyo'):
                continue
            if path.is_symlink():
                raise ValueError(f'Source symlinks are not packaged: {path}')
            if path.is_file():
                paths.append(path.relative_to(root).as_posix())
    return sorted(paths)


def verify(root: Path = ROOT) -> list[str]:
    listed = {}
    for line in (root / 'CHECKSUMS.sha256').read_text(encoding='utf-8').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
        if not match:
            raise ValueError('Invalid checksum manifest')
        checksum, name = match.groups()
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or name in listed:
            raise ValueError(f'Unsafe or duplicate manifest path: {name}')
        listed[name] = checksum
    actual = sources(root)
    if set(actual) != set(listed):
        raise ValueError('Source file list differs from CHECKSUMS.sha256; regenerate it before publishing')
    for name in actual:
        if digest(root / name) != listed[name]:
            raise ValueError(f'Checksum mismatch: {name}')
    return actual


def update_checksums() -> None:
    rows = [f'{digest(ROOT / name)}  {name}\n' for name in sources(ROOT)]
    (ROOT / 'CHECKSUMS.sha256').write_text(''.join(rows), encoding='utf-8')


def version(root: Path = ROOT) -> str:
    metadata = json.loads((root / UUID / 'metadata.json').read_text(encoding='utf-8'))
    if metadata.get('uuid') != UUID:
        raise ValueError('Unexpected extension UUID')
    match = re.fullmatch(r'(\d+\.\d+\.\d+)(?:[-+][A-Za-z0-9.-]+)?', metadata['version-name'])
    if not match:
        raise ValueError('version-name must start with a semantic version')
    return match[1]


def write_zip(output: Path, files: dict[str, Path]) -> None:
    # Deterministic file names/timestamps; no local build paths or user metadata.
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.popup-zip-', delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, source in sorted(files.items()):
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o100755 if name.endswith('.sh') else 0o100644) << 16
                archive.writestr(info, source.read_bytes())
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def build(output_dir: Path, tag: str | None = None) -> list[Path]:
    paths = verify()
    release_version = version()
    if tag is not None and tag != f'v{release_version}':
        raise ValueError(f'Tag {tag!r} does not match v{release_version}')
    if not shutil.which('glib-compile-schemas') or not shutil.which('gsettings'):
        raise ValueError('Developer packaging requires glib-compile-schemas and gsettings')
    output_dir = output_dir.resolve()
    if output_dir == ROOT or (ROOT / UUID) in (output_dir, *output_dir.parents):
        raise ValueError('Output must not overwrite the source or extension directory')
    output_dir.mkdir(parents=True, exist_ok=True)
    source_output = output_dir / f'Popup-LLM-Office-Assistent-v{release_version}-FullSource.zip'
    copy_output = output_dir / COPY_ASSET
    with tempfile.TemporaryDirectory(prefix='popup-release-') as staging_name:
        staging = Path(staging_name)
        shutil.copytree(ROOT / UUID, staging / UUID)
        schema_dir = staging / UUID / 'schemas'
        subprocess.run(['glib-compile-schemas', '--strict', str(schema_dir)], check=True)
        subprocess.run(['gsettings', '--schemadir', str(schema_dir), 'list-keys', SCHEMA],
                       env={**os.environ, 'GSETTINGS_BACKEND': 'memory'}, check=True,
                       stdout=subprocess.DEVNULL)
        shutil.copy2(ROOT / 'install.sh', staging / 'install.sh')
        shutil.copy2(ROOT / 'diagnose-ocr.sh', staging / 'diagnose-ocr.sh')
        shutil.copy2(ROOT / 'docs/INSTALL.md', staging / 'README.md')
        runtime_files = {path.relative_to(staging).as_posix(): path
                         for path in staging.rglob('*') if path.is_file()}
        checksums = ''.join(f'{digest(path)}  {name}\n' for name, path in sorted(runtime_files.items()))
        (staging / 'CHECKSUMS.sha256').write_text(checksums, encoding='utf-8')
        runtime_files['CHECKSUMS.sha256'] = staging / 'CHECKSUMS.sha256'
        write_zip(copy_output, runtime_files)
    write_zip(source_output, {name: ROOT / name for name in [*paths, 'CHECKSUMS.sha256']})
    outputs = [copy_output, source_output]
    (output_dir / 'SHA256SUMS').write_text(''.join(f'{digest(path)}  {path.name}\n' for path in outputs), encoding='utf-8')
    shutil.copy2(ROOT / 'RELEASE_NOTES.md', output_dir / 'RELEASE_NOTES.md')
    return outputs


def stage_source(destination: Path) -> None:
    paths = verify()
    destination = destination.resolve()
    if not (destination / '.git').is_dir():
        raise ValueError('Destination must be a fresh clone, not an arbitrary directory')
    if subprocess.check_output(['git', '-C', str(destination), 'status', '--porcelain']).strip():
        raise ValueError('Destination worktree is not clean; no files copied')
    has_head = subprocess.run(['git', '-C', str(destination), 'rev-parse', '--verify', 'HEAD'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    tracked = subprocess.check_output(['git', '-C', str(destination), 'ls-tree', '-rz', '--name-only', 'HEAD']) if has_head else b''
    extras = set(tracked.decode('utf-8').split('\0')) - set(paths) - {'', 'CHECKSUMS.sha256'}
    if extras:
        raise ValueError('Remote main contains additional files; inspect before publishing: ' + ', '.join(sorted(extras)))
    for name in [*paths, 'CHECKSUMS.sha256']:
        target = destination / name
        if not target.resolve().is_relative_to(destination) or target.is_symlink():
            raise ValueError(f'Unsafe destination path: {name}')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('checksums')
    check.add_argument('--check', action='store_true')
    package = commands.add_parser('build')
    package.add_argument('--output-dir', type=Path, default=ROOT / 'dist')
    package.add_argument('--tag')
    stage = commands.add_parser('stage-source')
    stage.add_argument('destination', type=Path)
    commands.add_parser('version')
    args = parser.parse_args()
    if args.command == 'checksums':
        if args.check:
            print(f'Verified {len(verify())} project source files')
        else:
            update_checksums()
    elif args.command == 'build':
        for path in build(args.output_dir, args.tag):
            print(path)
    elif args.command == 'stage-source':
        stage_source(args.destination)
    else:
        print(version())


if __name__ == '__main__':
    main()
