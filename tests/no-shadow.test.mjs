// Verify shipped CSS declarations/scope. This does not emulate St or GPU painting.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './extension-fixture.mjs';

const css = readFileSync(new URL('../popup-llm-officeassistent@yanjing_chen@qq.com/stylesheet.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(',').map(s => s.trim()),
    properties: Object.fromEntries(body.split(';').map(s => s.trim()).filter(Boolean).map(declaration => {
        const colon = declaration.indexOf(':');
        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
    })),
}));
const first = selector => rules.find(rule => rule.selectors.includes(selector))?.properties;

test('result window and internal dropdown explicitly remove their original box shadows', () => {
    assert.equal(first('.translator-result-window')['box-shadow'], 'none');
    assert.equal(first('.translator-dropdown-scroll')['box-shadow'], 'none');
    assert.doesNotMatch(css, /0 8px 24px rgba\(0, 0, 0, 0\.6\)/);
});

test('result root and every child override box, text and icon shadows', () => {
    const override = rules.find(rule => rule.selectors.includes('.translator-result-window *'));
    assert.ok(override);
    assert.deepEqual(override.selectors, ['.translator-result-window', '.translator-result-window *']);
    for (const property of ['box-shadow', 'text-shadow', 'icon-shadow'])
        assert.equal(override.properties[property], 'none !important');
});

test('high-priority shadow clearing never applies globally or to selection popups', () => {
    const overrides = rules.filter(rule => ['box-shadow', 'text-shadow', 'icon-shadow']
        .some(property => rule.properties[property]?.includes('!important')));
    assert.equal(overrides.length, 1);
    assert.ok(overrides.every(rule => rule.selectors.every(selector => selector.startsWith('.translator-result-window'))));
});

test('selection icon normal and hover shadows remain unchanged', () => {
    for (const prefix of ['translator', 'explain', 'mail', 'qa', 'custom']) {
        assert.equal(first(`.${prefix}-popup-icon`)['box-shadow'], '0 3px 8px rgba(0, 0, 0, 0.3)');
        assert.equal(first(`.${prefix}-popup-icon:hover`)['box-shadow'], '0 4px 12px rgba(0, 0, 0, 0.4)');
    }
});

test('opaque background, rounded layout, font sizes and blue actions are retained', () => {
    const window = first('.translator-result-window');
    assert.equal(window['background-color'], '#1e1e1e');
    assert.equal(window['border-radius'], '12px');
    assert.equal(window.padding, '12px');
    assert.equal(window.border, '1px solid rgba(255, 255, 255, 0.1)');
    assert.equal(first('.translator-result-text')['font-size'], '11pt');
    assert.equal(first('.translator-result-text')['line-height'], '1.6');
    assert.equal(first('.translator-action-btn')['background-color'], '#3584e4');
});

test('all six result windows use the same shadow-cleared root class', () => {
    for (const action of ['translate', 'explain', 'polish', 'mail', 'qa', 'custom']) {
        const f = fixture(); f.extension._showResultWindow('selected text', action);
        assert.deepEqual(f.logs, []);
        assert.ok(f.extension._resultContainer.style_class.split(/\s+/).includes('translator-result-window'), action);
        f.extension._closeUI();
    }
});
