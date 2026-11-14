import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('installer stages and upgrades only the isolated XDG extension; old files remain recoverable', {skip: process.getuid?.() === 0}, () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const data = mkdtempSync(join(tmpdir(), 'popup-llm-installer-test-'));
    const uuid = 'popup-llm-officeassistent@yanjing_chen@qq.com';
    const target = join(data, 'gnome-shell', 'extensions', uuid);
    const other = join(data, 'gnome-shell', 'extensions', 'unrelated-test');
    mkdirSync(target, {recursive: true}); mkdirSync(other, {recursive: true});
    writeFileSync(join(target, 'old-version-marker'), 'stable-before-upgrade');
    writeFileSync(join(other, 'untouched'), 'unrelated');
    const bin = join(data, 'test-cli');
    mkdirSync(bin);
    // Never contact the real user's running GNOME Shell during an installer test.
    writeFileSync(join(bin, 'gnome-extensions'), '#!/usr/bin/env bash\nexit 0\n', {mode: 0o755});
    const run = spawnSync('bash', [resolve(root, 'install.sh')], {
        cwd: root, encoding: 'utf8', env: {...process.env, XDG_DATA_HOME: data, PATH: `${bin}:${process.env.PATH}`},
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const prefs = readFileSync(join(target, 'prefs.js'), 'utf8');
    assert.match(prefs, /Model Idle Timeout/);
    assert.match(prefs, /Adw.ComboRow/);
    const backups = join(data, 'popup-llm-officeassistent', 'backups');
    const backup = join(backups, readdirSync(backups)[0], uuid);
    assert.equal(readFileSync(join(backup, 'old-version-marker'), 'utf8'), 'stable-before-upgrade');
    assert.equal(readFileSync(join(other, 'untouched'), 'utf8'), 'unrelated');
    assert.deepEqual(readdirSync(join(data, 'gnome-shell', 'extensions')).sort(), [uuid, 'unrelated-test'].sort());
});

test('installer restores previous extension after a late installation failure', {skip: process.getuid?.() === 0}, () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const data = mkdtempSync(join(tmpdir(), 'popup-llm-rollback-test-'));
    const uuid = 'popup-llm-officeassistent@yanjing_chen@qq.com';
    const target = join(data, 'gnome-shell', 'extensions', uuid);
    const bin = join(data, 'test-cli');
    mkdirSync(target, {recursive: true}); mkdirSync(bin);
    writeFileSync(join(target, 'old-version-marker'), 'stable');
    writeFileSync(join(bin, 'gnome-extensions'), '#!/usr/bin/env bash\nexit 0\n', {mode: 0o755});
    // Force an error after moving the new source into place. Rollback must recover.
    writeFileSync(join(bin, 'chmod'), '#!/usr/bin/env bash\nexit 23\n', {mode: 0o755});
    const run = spawnSync('bash', [resolve(root, 'install.sh')], {
        cwd: root, encoding: 'utf8', env: {...process.env, XDG_DATA_HOME: data, PATH: `${bin}:${process.env.PATH}`},
    });
    assert.equal(run.status, 23);
    assert.equal(readFileSync(join(target, 'old-version-marker'), 'utf8'), 'stable');
    assert.equal(existsSync(join(target, 'prefs.js')), false);
    const backups = join(data, 'popup-llm-officeassistent', 'backups');
    const failed = join(backups, readdirSync(backups)[0], `failed-new-${uuid}`);
    assert.equal(existsSync(join(failed, 'prefs.js')), true);
});
