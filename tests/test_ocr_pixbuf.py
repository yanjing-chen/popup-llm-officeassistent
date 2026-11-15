"""Optional native decoder smoke test, without GNOME Shell or a display."""
import base64
from pathlib import Path
import shutil
import subprocess
import unittest

try:
    import gi
    gi.require_version('GdkPixbuf', '2.0')
    from gi.repository import GdkPixbuf, Gio, GLib
    HAVE_PIXBUF = True
except (ImportError, ValueError):
    HAVE_PIXBUF = False

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(HAVE_PIXBUF and shutil.which('node'), 'optional native GdkPixbuf/Node not installed')
class NativeOcrPreviewTests(unittest.TestCase):
    def check_shape(self, width, height, expected):
        script = ("import {rectangleImage} from './tests/ocr-fixture.mjs'; "
                  f"process.stdout.write(Buffer.from(rectangleImage({width}, {height}).png).toString('base64'));")
        png = base64.b64decode(subprocess.check_output(
            ['node', '--input-type=module', '-e', script], cwd=ROOT))
        stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(png))
        loop = GLib.MainLoop()
        result, errors = [], []

        def complete(_source, ready):
            try:
                result.append(GdkPixbuf.Pixbuf.new_from_stream_finish(ready))
            except Exception as error:
                errors.append(error)
            loop.quit()

        timeout = GLib.timeout_add_seconds(5, lambda: (loop.quit(), False)[1])
        try:
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, 480, 220, True, None, complete)
            loop.run()
            self.assertFalse(errors)
            self.assertEqual(len(result), 1, 'native asynchronous decode did not complete')
            self.assertEqual((result[0].get_width(), result[0].get_height()), expected)
            self.assertGreater(result[0].read_pixel_bytes().get_size(), 0)
            self.assertGreaterEqual(result[0].get_rowstride(), expected[0] * result[0].get_n_channels())
        finally:
            # timeout is still live on normal completion; do not remove an
            # already-dispatched source if a genuine native timeout occurred.
            if result or errors:
                GLib.source_remove(timeout)
            stream.close(None)

    def test_native_landscape_is_not_square(self):
        self.check_shape(1600, 400, (480, 120))

    def test_native_portrait_is_not_square(self):
        self.check_shape(400, 1600, (55, 220))


if __name__ == '__main__':
    unittest.main()
