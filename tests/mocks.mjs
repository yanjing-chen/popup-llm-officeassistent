import {readFileSync} from 'node:fs';
import vm from 'node:vm';

export function loadClass(filename, name, globals) {
    const source = readFileSync(new URL(`../popup-llm-officeassistent@yanjing_chen@qq.com/${filename}`, import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\n/gm, '').replace(/export default class/g, 'class').replace(/export class/g, 'class');
    const context = vm.createContext({TextEncoder, TextDecoder, Promise, console, ...globals});
    return vm.runInContext(`${source}\n${name};`, context, {filename});
}

export class Widget {
    static all = [];
    constructor(properties = {}) {
        this.children = []; this.signals = new Map(); this.sensitive = true;
        this.active = false; this.selected = 0; this.value = properties.adjustment?.value || 0;
        this.text = ''; this.x = 100; this.y = 100; this.width = 450; this.height = 300;
        this.translation_x = 0; this.translation_y = 0; this.translation_z = 0;
        Object.assign(this, properties); Widget.all.push(this);
        if (properties.child) { this.children.push(properties.child); properties.child.parent = this; }
    }
    connect(signal, fn) { const id = this._signalId = (this._signalId || 0) + 1; this.signals.set(id, {signal, fn}); return id; }
    disconnect(id) { this.signals.delete(id); }
    emit(signal, ...args) { let result; for (const entry of [...this.signals.values()]) if (entry.signal === signal) result = entry.fn(this, ...args); return result; }
    add(widget) { this.add_child(widget); }
    add_row(widget) { this.add_child(widget); }
    add_suffix(widget) { this.add_child(widget); }
    add_prefix(widget) { this.add_child(widget); }
    add_child(widget) { this.children.push(widget); widget.parent = this; }
    addMenuItem(widget) { this.add_child(widget); }
    get_parent() { return this.parent || null; }
    get_children() { return [...this.children]; }
    contains(actor) { return this === actor || this.children.some(child => child.contains?.(actor)) || this._clutterText === actor; }
    set_child_above_sibling(actor, sibling = null) {
        if (actor.parent !== this || (sibling && sibling.parent !== this)) throw new Error('Restack requires siblings');
        if (actor === sibling) return;
        this.children = this.children.filter(child => child !== actor);
        const index = sibling ? this.children.indexOf(sibling) + 1 : this.children.length;
        this.children.splice(index, 0, actor);
    }
    set_child_below_sibling(actor, sibling = null) {
        if (actor.parent !== this || (sibling && sibling.parent !== this)) throw new Error('Restack requires siblings');
        if (actor === sibling) return;
        this.children = this.children.filter(child => child !== actor);
        const index = sibling ? this.children.indexOf(sibling) : 0;
        this.children.splice(index, 0, actor);
    }
    grab_key_focus() { Widget.focused = this; }
    add_controller() {}
    add_style_pseudo_class() {}
    remove_style_pseudo_class() {}
    add_css_class() {}
    remove_css_class() {}
    set_default_size() {}
    set_sensitive(value) { this.sensitive = value; }
    set_reactive(value) { this.reactive = value; }
    set_can_focus(value) { this.can_focus = value; }
    set_visible(value) { this.visible = value; }
    set_label(value) { this.label = value; }
    set_subtitle(value) { this.subtitle = value; }
    set_model(value) { this.model = value; this.selected = 4294967295; this.emit('notify::selected'); }
    set_selected(value) { this.selected = value; this.emit('notify::selected'); }
    get_selected() { return this.selected; }
    get_text() { return this.text; }
    set_text(value) {
        this.text = value;
        if (this._clutterText) this._clutterText.set_text(value);
        this._selectionStart = this._selectionEnd = 0;
        this.emit('notify::cursor-position'); this.emit('notify::selection-bound');
        this.emit('changed');
    }
    set_selection(start, end) {
        this._selectionStart = start;
        this._selectionEnd = end < 0 ? Array.from(this.text).length : end;
        this.emit('notify::cursor-position'); this.emit('notify::selection-bound');
    }
    get_selection() {
        const start = this._selectionStart || 0, end = this._selectionEnd || 0;
        return Array.from(this.text).slice(Math.min(start, end), Math.max(start, end)).join('');
    }
    set_selection_color(value) { this.selection_color = value; }
    set_selected_text_color(value) { this.selected_text_color = value; }
    set_cursor_type(value) { this.cursor_type = value; }
    get_attributes() { return this.attributes || null; }
    set_attributes(value) { this.attributes = value; }
    transform_stage_point(x, y) {
        const [ox, oy] = this._hitOrigin || [100, 200];
        const scale = this._hitScale || 1;
        return [true, (x - ox) / scale, (y - oy) / scale];
    }
    position_to_coords(position) {
        let row = 0, col = 0;
        const chars = Array.from(this.text), columns = this._hitColumns || 80;
        for (const ch of chars.slice(0, position)) {
            if (ch === '\n') { row++; col = 0; }
            else if (++col >= columns) { row++; col = 0; }
        }
        return [true, col * 10, row * 20, 20];
    }
    coords_to_position(x, y) {
        const targetRow = Math.max(0, Math.floor(y / 20));
        const targetColumn = Math.max(0, Math.round(x / 10));
        const chars = Array.from(this.text), columns = this._hitColumns || 80;
        let row = 0, col = 0, count = 0;
        for (const ch of chars) {
            if (row > targetRow || (row === targetRow && (col >= targetColumn || ch === '\n')))
                break;
            count++;
            if (ch === '\n' || ++col >= columns) { row++; col = 0; }
        }
        return this._hitCharacterIndices ? count : new TextEncoder().encode(chars.slice(0, count).join('')).length;
    }
    get_value() { return this.value; }
    set_value(value) { this.value = value; this.emit('notify::value'); }
    get_active() { return this.active; }
    get_enable_expansion() { return this.enable_expansion; }
    set_pixel_size(value) { this.pixel_size = value; }
    set_position(x, y) { this.x = x; this.y = y; }
    set_translation(x, y, z) { this.translation_x = x; this.translation_y = y; this.translation_z = z; }
    get_offscreen_redirect() { return this.offscreen_redirect || 0; }
    set_offscreen_redirect(value) { this.offscreen_redirect = value; (this.offscreenWrites ||= []).push(value); }
    get_transformed_position() { return [this.x + this.translation_x, this.y + this.translation_y]; }
    remove_transition(name) { (this.removedTransitions ||= []).push(name); }
    queue_redraw() { this.redraws = (this.redraws || 0) + 1; }
    set_width(value) { this.width = value; }
    set_height(value) { this.height = value; }
    set_style(value) { this.style = value; }
    get_style() { return this.style; }
    set_child(value) { this.children = this.children.filter(child => child !== this.child); this.child = value; if (value) this.add_child(value); }
    get_child() { return this.child || null; }
    get clutter_text() { if (!this._clutterText) { this._clutterText = new Widget({text: this.text}); this._clutterText.parent = this; } return this._clutterText; }
    get_clutter_text() { return this.clutter_text; }
    set_y(value) { this.y = value; }
    ease() {}
    add_response() {}
    set_default_response() {}
    set_close_response() {}
    set_response_appearance() {}
    present() { this.presented = true; }
    destroy() {
        if (this.destroyed) return;
        this.emit('destroy');
        this.destroyed = true;
        this._clutterText?.destroy();
        for (const child of this.children) child.destroy?.();
    }
}

export function settings() {
    const values = new Map([
        ['popup-mode', 'auto'], ['popup-shortcut', ['<Super>t']], ['icon-size', 24],
        ['auto-close-time', 5], ['model-idle-time', 60], ['temperature', 0.3],
        ['result-font-size', 11],
        ['translation-chunk-limit', 1400], ['explain-chunk-limit', 1400],
        ['polish-chunk-limit', 1400], ['independent-chunk-limits-initialized', false],
        ['api-url', 'http://localhost:11434/v1/chat/completions'], ['api-key', ''],
        ['target-lang', 'zh'], ['enable-stream', false], ['enable-think', true],
        ['enable-ocr', false], ['model-name-ocr', ''], ['system-prompt-ocr', 'OCR:'],
    ]);
    for (const suffix of ['', '-explain', '-polish', '-mail', '-qa', '-custom']) {
        values.set(`model-name${suffix}`, 'old-model'); values.set(`system-prompt${suffix}`, 'prompt');
    }
    const writes = [];
    const userValues = new Set();
    const result = {values, writes, userValues,
        get_user_value: key => userValues.has(key) ? {unpack: () => values.get(key)} : null};
    for (const type of ['string', 'strv', 'int', 'double', 'boolean']) {
        result[`get_${type}`] = key => values.get(key) ?? (type === 'boolean' ? true : '');
        result[`set_${type}`] = (key, value) => {
            writes.push([key, value]); values.set(key, value); userValues.add(key);
        };
    }
    return result;
}

export const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
