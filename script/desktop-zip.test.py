import importlib.util
import pathlib
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("desktop_zip", pathlib.Path(__file__).with_name("desktop-zip.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ZipTests(unittest.TestCase):
    def check_archive(self, entries, valid=False):
        with tempfile.TemporaryDirectory() as directory:
            filename = pathlib.Path(directory) / "app.zip"
            with zipfile.ZipFile(filename, "w") as archive:
                for name, target in entries:
                    entry = zipfile.ZipInfo(name)
                    if target is not None:
                        entry.create_system = 3
                        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(entry, target if target is not None else "payload")
            if valid:
                module.validate(filename)
            else:
                with self.assertRaises(ValueError):
                    module.validate(filename)

    def test_app_layout_and_internal_framework_symlink(self):
        self.check_archive([
            ("OpenCode.app/Contents/Info.plist", None),
            ("OpenCode.app/Contents/Frameworks/A.framework/Versions/A/A", None),
            ("OpenCode.app/Contents/Frameworks/A.framework/Versions/Current", "A"),
        ], valid=True)

    def test_unsafe_paths(self):
        for name in ("/OpenCode.app/a", "../escape", "OpenCode.app/../escape", "Other.app/a", "OpenCode.app\\a", "OpenCode.app//a"):
            with self.subTest(name=name):
                self.check_archive([(name, None)])

    def test_escaping_symlinks(self):
        for target in ("/tmp", "../../outside", "..\\outside"):
            with self.subTest(target=target):
                self.check_archive([("OpenCode.app/link", target)])

    def test_entry_beneath_symlink(self):
        self.check_archive([("OpenCode.app/link", "Contents"), ("OpenCode.app/link/a", None)])

    def test_empty_archive(self):
        self.check_archive([])


if __name__ == "__main__":
    unittest.main()
