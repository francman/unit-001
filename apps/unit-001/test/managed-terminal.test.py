"""#36: Run with python3 apps/unit-001/test/managed-terminal.test.py; no root or provider access."""
from pathlib import Path
import runpy
import unittest


verify_appearance = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / "scripts/verify-managed-terminal.py")
)["verify_appearance"]
HEADER = "unit-001  ·  agent  /  default".encode()


class ManagedTerminalAppearance(unittest.TestCase):
    def test_host_foreground_bold_header(self):
        verify_appearance(b"\x1b[1;39m" + HEADER + b"\x1b[0m \x1b[32mREADY", False)

    def test_rejects_monochrome_status_in_color_mode(self):
        with self.assertRaisesRegex(AssertionError, "semantic color"):
            verify_appearance(b"\x1b[1;39m" + HEADER + b"\x1b[0m READY", False)

    def test_plain_monochrome_header(self):
        verify_appearance(HEADER + b" READY", True)

    def test_rejects_old_cyan_and_unstyled_color_header(self):
        for prefix in (b"\x1b[1;36m", b""):
            with self.subTest(prefix=prefix), self.assertRaisesRegex(AssertionError, "bold terminal-foreground"):
                verify_appearance(prefix + HEADER, False)

    def test_rejects_missing_identity_or_session(self):
        for header in (b"READY", b"unit-001", b"agent  /  another-session"):
            with self.subTest(header=header), self.assertRaisesRegex(AssertionError, "identity/session"):
                verify_appearance(b"\x1b[1;39m" + header, False)

    def test_monochrome_rejects_foreground_background_and_compound_colors(self):
        for style in (b"31", b"44", b"90", b"107", b"1;39", b"38;2;100;200;255"):
            with self.subTest(style=style), self.assertRaisesRegex(AssertionError, "NO_COLOR"):
                verify_appearance(HEADER + b"\x1b[" + style + b"m", True)


if __name__ == "__main__":
    unittest.main()
