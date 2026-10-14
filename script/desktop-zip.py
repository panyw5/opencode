"""Validate updater ZIP paths before extraction; preserve internal App symlinks."""

import posixpath
import stat
import sys
import zipfile


def validate(filename):
    with zipfile.ZipFile(filename) as archive:
        entries = archive.infolist()
        if not entries:
            raise ValueError("Empty updater ZIP")
        seen = set()
        links = set()
        for entry in entries:
            name = entry.filename
            parts = name.rstrip("/").split("/")
            if (
                name.startswith("/")
                or "\\" in name
                or any(part in ("", ".", "..") for part in parts)
                or parts[0] != "OpenCode.app"
                or name in seen
            ):
                raise ValueError(f"Unsafe ZIP entry: {name}")
            seen.add(name)
            if stat.S_ISLNK(entry.external_attr >> 16):
                target = archive.read(entry).decode("utf-8")
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if (
                    target.startswith("/")
                    or "\\" in target
                    or "\x00" in target
                    or not resolved.startswith("OpenCode.app/")
                ):
                    raise ValueError(f"Escaping ZIP symlink: {name}")
                links.add(name)
        # Never extract an entry through a symlink, even if its target is internal.
        for entry in entries:
            parts = entry.filename.rstrip("/").split("/")
            if any("/".join(parts[:i]) in links for i in range(1, len(parts))):
                raise ValueError(f"ZIP entry beneath symlink: {entry.filename}")


if __name__ == "__main__":
    validate(sys.argv[1])
    print("[desktop-macos] ZIP paths and symlink boundaries verified")
