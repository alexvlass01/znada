'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { makeTempDir } = require('./helpers/temp-dir');
const runtime = require('../src/video-runtime');
const { verifyPackage } = require('../scripts/verify-thumbnail-package');
const root = makeTempDir('znada-video-resource-');
const resources = path.join(root, 'resources'), video = path.join(resources, 'libmpv');
fs.mkdirSync(video, { recursive: true });
for (const file of runtime.FILES) fs.writeFileSync(path.join(video, file), 'fixture');
assert.equal(runtime.verifyRuntime(video, { verifyDigest: false }), path.join(video, 'libmpv-2.dll'));
assert.throws(() => runtime.verifyRuntime(video), /digest mismatch/);
fs.writeFileSync(path.join(video, 'extra.txt'), 'unexpected');
assert.throws(() => runtime.verifyRuntime(video, { verifyDigest: false }), /resource boundary/);
fs.unlinkSync(path.join(video, 'extra.txt'));
fs.unlinkSync(path.join(video, 'LICENSE.LGPL'));
assert.throws(() => runtime.verifyRuntime(video, { verifyDigest: false }), /resource boundary/);
fs.writeFileSync(path.join(video, 'LICENSE.LGPL'), 'fixture');
fs.writeFileSync(path.join(resources, 'app.asar'), 'fixture');
const addon = path.join(resources, 'app.asar.unpacked/node_modules/koffi/build/koffi/win32_x64');
fs.mkdirSync(addon, { recursive: true }); fs.writeFileSync(path.join(addon, 'koffi.node'), 'fixture');
const helper = path.join(resources, 'thumbnail-helper'); fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper, 'source.sha256'), 'a'.repeat(64));
fs.writeFileSync(path.join(helper, 'Znada.ThumbnailHelper.exe'), 'fixture');
// Full package verification must require pinned bytes, even though users can replace a DLL at runtime.
assert.throws(() => verifyPackage({ packageRoot: root }), /digest mismatch/);
console.log('PASS video-runtime: resource closure, license presence, tampering and strict package digest');
