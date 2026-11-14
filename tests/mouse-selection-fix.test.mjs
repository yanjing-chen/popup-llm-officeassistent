import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './extension-fixture.mjs';
import {mouseSelect, pointAt, pointerEvent} from './mouse-selection.mjs';
import {makeTextMap, characterAtByte, selectionRange} from '../popup-llm-officeassistent@yanjing_chen@qq.com/textSelection.js';
import {settle} from './mocks.mjs';

function open(action = 'translate') {
    const f = fixture(); f.extension._closeUI();
    const window = f.createWindow('original external source', action);
    if (window._resultLabel)
        window._setResultText('before chosen phrase after');
    const label = window._resultLabel, text = label?.get_clutter_text();
    const copy = () => [...window._copyButtons].find(button => button.get_parent());
    const clickCopy = () => {
        const button = copy();
        window._resultContainer.emit('captured-event', pointerEvent(f, button.child, [700, 150]));
        button.emit('clicked');
    };
    return {...f, window, label, text, copy, clickCopy};
}

test('real pointer-handler path creates the range instead of relying on native read-only text selection', () => {
    const f = open(); let writes = 0;
    const nativeSet = f.text.set_selection.bind(f.text);
    f.text.set_selection = (...args) => {writes++; nativeSet(...args);};
    mouseSelect(f, f.window, f.label, 7, 20);
    assert.ok(writes >= 2); assert.equal(f.window._getOutputSelection(), 'chosen phrase');
    assert.equal(f.label.text, 'before chosen phrase after');
    assert.equal(f.text.editable, false); assert.equal(f.text.cursor_visible, false);
});

for (const labelTarget of [false, true]) {
    test(`both label and inner-text pick targets support pointer selection (${labelTarget})`, () => {
        const f = open();
        mouseSelect(f, f.window, f.label, 7, 20, {source: labelTarget ? f.label : f.text});
        assert.equal(f.window._getOutputSelection(), 'chosen phrase');
        assert.equal(f.manager._popupSource.window, f.window);
    });
}

test('right-to-left pointer dragging produces a correctly ordered selection and highlight', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 20, 7);
    assert.equal(f.window._getOutputSelection(), 'chosen phrase');
    const bg = f.text.attributes.items.find(item => item.kind === 'background');
    assert.equal(bg.start_index, 7); assert.equal(bg.end_index, 20);
});

test('Pango highlight attributes cover the span with a hidden caret and read-only text', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 7, 20);
    const attributes = f.text.attributes.items;
    assert.equal(attributes.length, 2);
    assert.deepEqual(attributes.map(attr => attr.kind), ['background', 'foreground']);
    assert.equal(attributes[0].blue, 228 * 257);
    assert.equal(attributes[1].red, 65535);
    assert.ok(f.text.redraws && f.label.redraws);
});

for (const charIndices of [false, true]) {
    test(`UTF-8 hit positions are converted correctly; character-index fallback=${charIndices}`, () => {
        const f = open(); f.window._setResultText('甲😀乙荷兰语丙'); f.text._hitCharacterIndices = charIndices;
        mouseSelect(f, f.window, f.label, 1, 6);
        assert.equal(f.window._getOutputSelection(), '😀乙荷兰语');
        const bg = f.text.attributes.items[0];
        assert.equal(bg.start_index, 3); assert.equal(bg.end_index, 19);
    });
}

test('moved/scaled actor coordinates are unprojected before text hit testing', () => {
    const f = open(); f.text._hitOrigin = [530, 410]; f.text._hitScale = 1.5;
    mouseSelect(f, f.window, f.label, 7, 20);
    assert.equal(f.window._getOutputSelection(), 'chosen phrase');
});

test('wrapped multiline text can be selected across lines', () => {
    const f = open(); f.window._setResultText('abcdefgh\n荷兰语😀klmnop'); f.text._hitColumns = 80;
    mouseSelect(f, f.window, f.label, 3, 14);
    assert.equal(f.window._getOutputSelection(), Array.from(f.label.text).slice(3, 14).join(''));
});

test('releasing outside the text ends selection through the existing actor frame tracker', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 7, 20, {outsideRelease: true});
    assert.equal(f.window._selectionState.selecting, false);
    assert.equal(f.window._selectionLoop, null);
    assert.equal(f.window._getOutputSelection(), 'chosen phrase');
});

test('copy button preserves the selected span through its press and copies no surrounding text', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 7, 20);
    const state = f.window._selectionState; f.clickCopy();
    assert.equal(f.window._selectionState, state);
    assert.deepEqual(f.clipboardWrites.at(-1), {type: f.St.ClipboardType.CLIPBOARD, text: 'chosen phrase'});
});

test('copy intent snapshot survives a native focus-related selection collapse', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 7, 20);
    const button = f.copy();
    f.window._resultContainer.emit('captured-event', pointerEvent(f, button.child, [700, 150]));
    // Simulate the native focus transition only, not creation of a test selection.
    f.text.set_selection(0, 0);
    button.emit('clicked');
    assert.equal(f.clipboardWrites.at(-1).text, 'chosen phrase');
});

test('copying with no selection retains the original whole-result copy option', () => {
    const f = open(); f.clickCopy();
    assert.equal(f.clipboardWrites.at(-1).text, 'before chosen phrase after');
});

test('mail bottom copy button copies the selected fragment and shows its own feedback', () => {
    const f = open('mail'); mouseSelect(f, f.window, f.label, 7, 20); f.clickCopy();
    assert.equal(f.clipboardWrites.at(-1).text, 'chosen phrase');
    assert.equal(f.copy().child.icon_name, 'object-select-symbolic');
});

test('QA question selection takes precedence over the complete last assistant answer', async () => {
    const f = open('qa'); f.window._qaEntry.set_text('question fragment rest');
    f.window._qaEntry.get_clutter_text().emit('activate'); await settle();
    f.reply(0, 'complete assistant answer');
    const user = f.window._chatContainer.children.find(child => child.style_class === 'qa-chat-user');
    mouseSelect(f, f.window, user, 3, 11); f.clickCopy();
    assert.equal(f.clipboardWrites.at(-1).text, 'question');
});

test('timeout hides only the toolbar; selection remains available for on-demand copy', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 7, 20);
    f.tick(); assert.equal(f.manager._popupContainer, null);
    assert.equal(f.window._getOutputSelection(), 'chosen phrase');
    f.clickCopy(); assert.equal(f.clipboardWrites.at(-1).text, 'chosen phrase');
});

test('right-click reopens six-function processing for an existing selection after timeout', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 7, 20); f.tick();
    f.text.emit('button-press-event', pointerEvent(f, f.text, pointAt(f.text, 10), 3));
    assert.equal(f.manager._popupContainer.children.length, 6);
    f.manager._popupContainer.children[2].emit('clicked'); f.flushIdles();
    assert.equal(f.manager._windows.size, 2); assert.equal(f.window._closed, false);
});

test('Escape clears a retained selection before closing its result window', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 7, 20); f.tick();
    f.manager._handleEscape(); assert.equal(f.window._closed, false);
    assert.equal(f.window._selectionState, null); assert.equal(f.text.get_attributes(), null);
    f.manager._handleEscape(); assert.equal(f.window._closed, true);
});

test('cancel restores pre-existing Pango attributes and flushes buffered visible output', () => {
    const f = open(); const attrs = new f.Pango.AttrList(); attrs.insert({kind: 'font-feature', value: 'kern=1'});
    f.text.set_attributes(attrs); mouseSelect(f, f.window, f.label, 7, 20);
    f.window._setResultText('latest complete model answer');
    assert.equal(f.label.text, 'before chosen phrase after');
    f.window._clearOutputSelection();
    assert.equal(f.label.text, 'latest complete model answer');
    assert.deepEqual(f.text.attributes.items, [{kind: 'font-feature', value: 'kern=1'}]);
});

test('Shift-click extends the existing character anchor rather than starting a new range', () => {
    const f = open(); mouseSelect(f, f.window, f.label, 7, 20);
    mouseSelect(f, f.window, f.label, 23, 23, {modifiers: 1});
    assert.equal(f.window._getOutputSelection(), f.label.text.slice(7, 23));
});

test('whitespace-only selections remain copyable without sending an empty LLM action', () => {
    const f = open(); f.window._setResultText('a   b'); mouseSelect(f, f.window, f.label, 1, 4);
    assert.ok(!f.manager._popupContainer); f.clickCopy(); assert.equal(f.clipboardWrites.at(-1).text, '   ');
});

test('copyable text selection remains available when every LLM action is disabled', () => {
    const f = open();
    for (const action of ['translate', 'explain', 'polish', 'mail', 'qa', 'custom'])
        f.config.values.set('enable-' + action, false);
    mouseSelect(f, f.window, f.label, 7, 20);
    assert.equal(f.window._getOutputSelection(), 'chosen phrase');
    assert.ok(!f.manager._popupContainer); f.clickCopy();
    assert.equal(f.clipboardWrites.at(-1).text, 'chosen phrase');
});

test('plain angle brackets, ampersands and Unicode are selected without markup rewriting', () => {
    const f = open(); f.window._setResultText('<b>&😀é literal'); mouseSelect(f, f.window, f.label, 0, 7);
    assert.equal(f.window._getOutputSelection(), '<b>&😀é ');
    assert.equal(f.label.text, '<b>&😀é literal');
});

test('failed coordinate conversion cannot leave a pointer tracker or frozen display alive', () => {
    const f = open(); f.text.transform_stage_point = () => [false, 0, 0];
    const event = pointerEvent(f, f.text, [170, 210]);
    assert.equal(f.text.emit('button-press-event', event), 0);
    assert.equal(f.window._selectionState, null); assert.equal(f.sources.size, 0);
});

test('window-local capture creates the range before a scroll view or text default can consume the press', () => {
    const f = open(); const emit = f.text.emit.bind(f.text);
    f.text.emit = (signal, ...args) => {
        if (signal === 'button-press-event') throw new Error('capture should handle the press first');
        return emit(signal, ...args);
    };
    mouseSelect(f, f.window, f.label, 7, 20);
    assert.equal(f.window._getOutputSelection(), 'chosen phrase');
});

test('readonly native range metadata failure cannot prevent manual highlighting and copying', () => {
    const f = open(); f.text.set_selection = () => {throw new Error('native selection metadata unavailable');};
    mouseSelect(f, f.window, f.label, 7, 20);
    assert.equal(f.window._getOutputSelection(), 'chosen phrase');
    assert.equal(f.text.attributes.items[0].start_index, 7);
    f.clickCopy(); assert.equal(f.clipboardWrites.at(-1).text, 'chosen phrase');
    f.window._clearOutputSelection(); assert.equal(f.text.get_attributes(), null);
});

test('external PRIMARY changes override an old retained selection in shortcut mode', () => {
    const f = open(); f.config.values.set('popup-mode', 'shortcut'); let shortcut;
    f.main.wm.addKeybinding = (_name, _settings, _flags, _modes, callback) => {shortcut = callback;};
    f.manager._updatePopupMode(); mouseSelect(f, f.window, f.label, 7, 20);
    f.clipboardValues.set(f.St.ClipboardType.PRIMARY, 'fresh external selection');
    f.selection.emit('owner-changed', 0); shortcut();
    assert.equal(f.manager._lastText, 'fresh external selection');
    assert.equal(f.manager._popupSource, null);
});

test('clearing PRIMARY does not prevent shortcut reopening of a retained internal selection', () => {
    const f = open(); f.config.values.set('popup-mode', 'shortcut'); let shortcut;
    f.main.wm.addKeybinding = (_name, _settings, _flags, _modes, callback) => {shortcut = callback;};
    f.manager._updatePopupMode(); mouseSelect(f, f.window, f.label, 7, 20);
    f.selection.emit('owner-changed', 0); shortcut();
    assert.equal(f.manager._popupSource.window, f.window);
});

test('UTF-8 map uses code points rather than UTF-16 units and converts byte attribute spans', () => {
    const map = makeTextMap('甲😀éZ');
    assert.deepEqual(map.bytes, [0, 3, 7, 9, 10]);
    assert.equal(characterAtByte(map, 7), 2); assert.equal(characterAtByte(map, 4), 1);
    assert.deepEqual(selectionRange(map, 3, 1), {start: 1, end: 3, byteStart: 3, byteEnd: 9, text: '😀é'});
});

test('selection input tests never create a successful range by directly invoking set_selection', () => {
    const helper = readFileSync(new URL('./mouse-selection.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(helper, /\.set_selection\(/);
});
