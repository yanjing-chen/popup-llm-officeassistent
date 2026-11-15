"""Optional real-Pango hit tests, passed into the production JavaScript method."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest

try:
    import gi
    gi.require_version('Pango', '1.0')
    gi.require_version('PangoCairo', '1.0')
    from gi.repository import Pango, PangoCairo
    HAVE_PANGO = True
except (ImportError, ValueError):
    HAVE_PANGO = False

ROOT = Path(__file__).resolve().parents[1]
RUN_PRODUCTION = r'''
import fs from 'node:fs';
import {fixture} from './tests/extension-fixture.mjs';
const samples = JSON.parse(fs.readFileSync(0, 'utf8')), results = [];
for (const sample of samples) {
    const f = fixture(); f.extension._closeUI();
    const win = f.createWindow('source', 'translate'); win._setResultText(sample.text);
    const label = win._resultLabel, actor = label.get_clutter_text();
    const resourceScale = sample.resource_scale;
    actor.height = sample.height / resourceScale + 9; actor._hitScale = 1.5;
    actor.get_resource_scale = () => resourceScale;
    actor.get_layout_offsets = () => [7 * resourceScale, 9 * resourceScale];
    actor.get_layout = () => ({xy_to_index(x, y) {
        if (Math.abs(x - sample.x) > 1 || Math.abs(y - sample.y) > 1)
            throw new Error('incorrect Pango coordinate transform');
        return sample.hit;
    }, index_to_pos: () => sample.rect,
    move_cursor_visually: () => sample.next_hit});
    actor.coords_to_position = () => sample.hit[1] + sample.hit[2];
    const state = win._ensureSelectionState(label);
    const position = win._outputPositionAt(state,
        100 + (7 + sample.x / 1024 / resourceScale) * 1.5,
        200 + (9 + sample.y / 1024 / resourceScale) * 1.5);
    results.push(position); f.manager.disable();
}
process.stdout.write(JSON.stringify(results));
'''


@unittest.skipUnless(HAVE_PANGO and shutil.which('node'), 'optional native Pango/Node not installed')
class NativePangoSelectionTests(unittest.TestCase):
    def check_endpoints(self, text, width=None, rtl=False, resource_scale=1, interior=False):
        layout = Pango.Layout.new(PangoCairo.FontMap.get_default().create_context())
        font = Pango.FontDescription('Sans 14')
        font.set_size(round(font.get_size() * resource_scale))
        layout.set_font_description(font)
        layout.set_text(text, -1)
        if width:
            layout.set_width(round(width * Pango.SCALE * resource_scale))
            layout.set_wrap(Pango.WrapMode.CHAR)
        _, height = layout.get_pixel_size()
        samples, expected = [], []
        encoded = text.encode('utf-8')
        iterator = layout.get_iter()
        while True:
            line = iterator.get_line_readonly()
            _, rect = iterator.get_line_extents()
            x = rect.x - 30 * Pango.SCALE if rtl else rect.x + rect.width + 30 * Pango.SCALE
            if interior:
                x = rect.x + rect.width // 3
            y = rect.y + rect.height // 2
            inside, byte_index, trailing = layout.xy_to_index(x, y)
            end = line.start_index + line.length
            target = len(encoded[:end].decode('utf-8'))
            # Out-of-line hits are valid CLAMPED caret positions, not errors.
            if interior:
                self.assertTrue(inside)
                target = len(encoded[:byte_index].decode('utf-8')) + trailing
            else:
                self.assertFalse(inside)
            glyph = layout.index_to_pos(byte_index)
            next_hit = tuple(layout.move_cursor_visually(True, byte_index, 0, 1 if glyph.width > 0 else -1))
            adjusted_index, adjusted_trailing = byte_index, trailing
            past_edge = (x >= glyph.x + glyph.width if glyph.width > 0 else
                         glyph.width < 0 and x <= glyph.x + glyph.width)
            if not inside and trailing == 0 and past_edge and glyph.y <= y < glyph.y + glyph.height:
                adjusted_index, adjusted_trailing = next_hit
            self.assertEqual(len(encoded[:adjusted_index].decode('utf-8')) + adjusted_trailing, target)
            samples.append(dict(text=text, height=height, x=x, y=y, resource_scale=resource_scale,
                                hit=[bool(inside), byte_index, trailing], next_hit=list(next_hit),
                                rect=dict(x=glyph.x, y=glyph.y, width=glyph.width, height=glyph.height)))
            expected.append(target)
            if not iterator.next_line():
                break
        process = subprocess.run(['node', '--input-type=module', '-e', RUN_PRODUCTION],
                                 cwd=ROOT, input=json.dumps(samples), text=True,
                                 capture_output=True, timeout=15)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout), expected)

    def test_chinese_same_line_final_character(self):
        self.check_endpoints('这是中文最后一个字')

    def test_chinese_soft_wrapped_lines(self):
        self.check_endpoints('这是中文自动换行之后也应该完整选取的最后一个字', width=140)

    def test_chinese_hard_line_breaks(self):
        self.check_endpoints('第一行中文\n第二行中文末字')

    def test_mixed_western_chinese_and_graphemes(self):
        self.check_endpoints('中文café，末字e\u0301👨‍👩‍👧‍👦')

    def test_right_to_left_native_caret_endpoint(self):
        self.check_endpoints('שלום עולם', rtl=True)

    def test_western_ascii_control(self):
        self.check_endpoints('Nederlands and English.')

    def test_2x_layout_all_four_visual_lines_follow_logical_pointer(self):
        self.check_endpoints('第一行中文文字\n第二行中文文字\n第三行中文文字\n最后一行中文末字',
                             resource_scale=2, interior=True)

    def test_2x_layout_preserves_corrected_soft_wrap_endpoints(self):
        self.check_endpoints('这是中文自动换行之后也应该完整选取的最后一个字', width=140, resource_scale=2)

    def test_fractional_render_scale_and_actor_transform_are_independent(self):
        self.check_endpoints('第一行中文\n第二行中文\n第三行末字', resource_scale=1.5, interior=True)

    def test_2x_mixed_text_and_final_grapheme_still_select_completely(self):
        self.check_endpoints('中文café，末字e\u0301👨‍👩‍👧‍👦', resource_scale=2)


if __name__ == '__main__':
    unittest.main()
