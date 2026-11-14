// Z-order/control-flow contract tests. Actual compositor picking still needs
// GNOME desktop acceptance; these tests do not claim native GPU verification.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './extension-fixture.mjs';
import {Widget} from './mocks.mjs';
import {mouseSelect} from './mouse-selection.mjs';

function open(options = {}) {
    const f = fixture({chromeBoundary: true, ...options}); f.extension._closeUI();
    const a = f.createWindow('first source', 'translate'); a._setResultText('first chosen phrase end');
    const b = f.createWindow('second source', 'polish'); b._setResultText('second selected text end');
    return {...f, a, b};
}

function assertToolbarAboveResults(f) {
    const toolbar = f.manager._popupContainer;
    assert.ok(toolbar && !toolbar.destroyed);
    const children = toolbar.get_parent().get_children();
    for (const window of f.manager._windows) {
        const actor = window._resultContainer;
        if (!window._closed && actor?.get_parent() === toolbar.get_parent())
            assert.ok(children.indexOf(toolbar) > children.indexOf(actor), 'toolbar must remain above every result');
    }
}

test('newly shown toolbar is above old results even when ordinary chrome insertion is not topmost', () => {
    const f = open(); f.manager._showPopupIcon('second-round input');
    assertToolbarAboveResults(f);
    assert.equal(f.manager._windows.size, 2); assert.equal(f.grabCalls(), 0);
});

test('activating any previous result cannot cover an already visible toolbar', () => {
    const f = open(); f.manager._showPopupIcon('input');
    for (const window of [f.a, f.b, f.a, f.b]) {
        f.manager._activateWindow(window); assertToolbarAboveResults(f);
        const resultActors = f.chrome.get_children().filter(actor => [...f.manager._windows].some(item => item._resultContainer === actor));
        assert.equal(resultActors.at(-1), window._resultContainer);
    }
});

test('raising result windows preserves the reserved Shell UI boundary instead of raising to absolute top', () => {
    const f = open(); f.manager._showPopupIcon('input');
    for (const window of [f.a, f.b]) f.manager._activateWindow(window);
    const children = f.chrome.get_children(), reserved = children.indexOf(f.chromeBoundaryActor);
    for (const window of f.manager._windows) assert.ok(children.indexOf(window._resultContainer) < reserved);
    assert.ok(children.indexOf(f.manager._popupContainer) < reserved);
    assertToolbarAboveResults(f);
});

test('toolbar also stays above results when chrome is a plain sibling list with no reserved boundary', () => {
    const f = open({chromeBoundary: false}); f.manager._showPopupIcon('input');
    f.manager._activateWindow(f.a); assertToolbarAboveResults(f);
    assert.equal(f.chrome.get_children().at(-1), f.manager._popupContainer);
});

test('selection in a lower result shows the second-round toolbar above every existing result', () => {
    const f = open();
    mouseSelect(f, f.a, f.a._resultLabel, 6, 19);
    assert.equal(f.manager._popupSource.window, f.a);
    assert.equal(f.a._getOutputSelection(), 'chosen phrase');
    assertToolbarAboveResults(f);
});

for (const [index, action] of ['translate', 'explain', 'polish', 'mail', 'qa', 'custom'].entries()) {
    test(`second-round ${action} button remains actionable and opens a separate result`, () => {
        const f = open(); mouseSelect(f, f.a, f.a._resultLabel, 6, 19);
        const toolbar = f.manager._popupContainer;
        f.manager._activateWindow(f.b); assertToolbarAboveResults(f);
        toolbar.children[index].emit('clicked'); f.flushIdles();
        assert.equal(toolbar.destroyed, true); assert.equal(f.manager._popupContainer, null);
        assert.equal(f.manager._windows.size, 3); assert.equal(f.a._closed, false); assert.equal(f.b._closed, false);
        assert.notEqual(f.manager._activeWindow, f.a); assert.notEqual(f.manager._activeWindow, f.b);
    });
}

test('a subsequent selection replaces the toolbar without leaving a stale button layer', () => {
    const f = open(); mouseSelect(f, f.a, f.a._resultLabel, 6, 19);
    const previous = f.manager._popupContainer;
    mouseSelect(f, f.b, f.b._resultLabel, 7, 15);
    assert.equal(previous.destroyed, true); assert.equal(previous.get_parent(), null);
    assert.equal(f.manager._popupSource.window, f.b); assertToolbarAboveResults(f);
    assert.equal(f.chrome.get_children().filter(actor => actor.style_class === 'translator-popup-container').length, 1);
});

test('repeated activation of an already frontmost result neither restacks nor adds timers', () => {
    const f = open(); f.manager._showPopupIcon('input');
    const original = f.chrome.set_child_above_sibling.bind(f.chrome); let restacks = 0;
    f.chrome.set_child_above_sibling = (...args) => {restacks++; original(...args);};
    const sources = [...f.sources.keys()];
    for (let count = 0; count < 100; count++) f.manager._activateWindow(f.b);
    assert.equal(restacks, 0); assert.deepEqual([...f.sources.keys()], sources);
    assertToolbarAboveResults(f);
});

test('toolbar timeout removes only its own layer and leaves all result actors alive', () => {
    const f = open(); f.manager._showPopupIcon('input');
    const toolbar = f.manager._popupContainer; f.tick();
    assert.equal(toolbar.destroyed, true); assert.equal(toolbar.get_parent(), null);
    assert.equal(f.manager._windows.size, 2);
    assert.ok(f.a._resultContainer.get_parent()); assert.ok(f.b._resultContainer.get_parent());
});

test('closing one result does not dismiss an unrelated external selection toolbar', () => {
    const f = open(); f.manager._showPopupIcon('external input');
    const toolbar = f.manager._popupContainer; f.a._closeUI();
    assert.equal(f.manager._popupContainer, toolbar); assertToolbarAboveResults(f);
    f.b._closeUI(); assert.equal(f.manager._popupContainer, toolbar);
    f.manager._closePopupIcon(); assert.equal(toolbar.destroyed, true);
});

test('restacking ignores detached result actors and never uses cross-parent siblings', () => {
    const f = open();
    f.main.layoutManager.removeChrome(f.a._resultContainer);
    const elsewhere = new Widget(); elsewhere.add_child(f.a._resultContainer);
    f.manager._showPopupIcon('input');
    f.manager._activateWindow(f.a); assertToolbarAboveResults(f);
    assert.equal(f.a._resultContainer.get_parent(), elsewhere);
});

test('lock and overview cleanup remove the foreground toolbar without closing results', () => {
    const f = open(); f.manager._showPopupIcon('input');
    const toolbar = f.manager._popupContainer; f.manager._stopInteractions();
    assert.equal(toolbar.destroyed, true); assert.equal(f.manager._popupContainer, null);
    assert.equal(f.manager._windows.size, 2); assert.equal(f.grabCalls(), 0);
});
