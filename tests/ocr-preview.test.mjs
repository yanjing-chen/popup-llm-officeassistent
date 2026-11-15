import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {rectangleImage, microtasks} from './ocr-fixture.mjs';
import {ocrPreviewSize} from '../popup-llm-officeassistent@yanjing_chen@qq.com/ocrUtils.js';

for (const [width, height, expected] of [[1600, 400, {width: 480, height: 120}],
    [400, 1600, {width: 55, height: 220}], [100, 20, {width: 100, height: 20}],
    [1000, 1000, {width: 220, height: 220}]]) {
    test(`OCR preview fits ${width}x${height} without stretching, cropping or upscaling`, async () => {
        const f = fixture(), original = rectangleImage(width, height);
        const preview = new f.OcrPreview(original.png, 480, 220);
        assert.equal(preview.actor.width, expected.width); assert.equal(preview.actor.height, expected.height);
        const actor = preview.actor; await preview.ready;
        assert.equal(actor.child.width, expected.width); assert.equal(actor.child.height, expected.height);
        assert.equal(actor.child.content_gravity, f.Clutter.ContentGravity.RESIZE_ASPECT);
        assert.equal(f.previewLoads[0].preserve, true);
        assert.deepEqual(f.previewLoads[0].stream.bytes.data, original.png);
        assert.equal(f.previewLoads[0].stream.closed, true);
        assert.equal(f.previewTextures[0].context.nativeContext, true);
        assert.equal(f.previewTextures[0].format, 4);
        actor.destroy(); assert.equal(preview.disposed, true); f.manager.disable();
    });
}

test('preview uses a high-DPI texture but keeps logical actor size and original image untouched', async () => {
    const f = fixture(), original = rectangleImage(1600, 400), snapshot = original.png.slice();
    f.St.ThemeContext.get_for_stage = () => ({scale_factor: 2});
    const preview = new f.OcrPreview(original.png, 480, 220), actor = preview.actor;
    await preview.ready;
    assert.equal(actor.width, 480); assert.equal(actor.height, 120);
    assert.equal(f.previewLoads[0].width, 960); assert.equal(f.previewLoads[0].height, 240);
    assert.deepEqual(original.png, snapshot); actor.destroy(); f.manager.disable();
});

test('closing during asynchronous thumbnail decode cancels loading without publishing a late texture', async () => {
    const f = fixture(), preview = new f.OcrPreview(rectangleImage(1000, 100).png, 480, 220);
    preview.actor.destroy(); await preview.ready;
    assert.equal(f.previewLoads[0].cancellable.is_cancelled(), true);
    assert.equal(f.previewLoads[0].stream.closed, true); assert.equal(f.previewTextures.length, 0);
    assert.equal(preview.actor, null); assert.deepEqual(f.logs, []); f.manager.disable();
});

test('a preview upload failure leaves OCR available and emits a safe distinct preview code', async () => {
    const f = fixture();
    f.St.ImageContent.new_with_preferred_size = () => {throw new Error('private image detail');};
    const preview = new f.OcrPreview(rectangleImage(1000, 100).png, 480, 220), actor = preview.actor;
    await preview.ready;
    assert.match(actor.child.text, /原图仍可识别/);
    assert.match(f.logs.join('\n'), /PREVIEW_LOAD_FAILED/); assert.doesNotMatch(f.logs.join('\n'), /private/);
    assert.equal(f.previewLoads[0].stream.closed, true); actor.destroy(); f.manager.disable();
});

test('closing OCR result disposes only its own preview without changing other results', async () => {
    const f = fixture({ocr: true}); f.extension._closeUI();
    const a = f.createWindow('', 'ocr', {ocrImage: rectangleImage(1000, 100)});
    const b = f.createWindow('', 'ocr', {ocrImage: rectangleImage(100, 1000)});
    const preview = a._ocrPreview; a._closeUI(); await microtasks();
    assert.equal(preview.disposed, true); assert.equal(a._ocrPreview, null);
    assert.equal(b._ocrPreview.disposed, undefined); assert.ok(b._ocrPreview.actor.child.content);
    f.manager.disable();
});

test('invalid preview limits are rejected rather than producing invalid actor dimensions', () => {
    for (const value of [0, -1, NaN, Infinity])
        assert.throws(() => ocrPreviewSize(100, 50, value, 220), /尺寸/);
});
