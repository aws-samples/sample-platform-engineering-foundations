#!/usr/bin/env python3
"""build.py - deterministic zip of main.py, embedded as base64 in recipes/serverless-compositions.yaml.

The zip is STORED (no compression), with a fixed timestamp and mode, so the same main.py always gives
the same bytes on any machine and Python version: the embedded literal is reproducible and reviewable.
Two literals are owned by this script, both in the XLambdaFunction Composition:
  contentBase64   the zip (resource `code`, the S3 object the function is created from)
  sourceCodeHash  base64(SHA-256(zip)), the CodeSha256 Lambda reports (resource `function`): a new
                  hash makes the provider call UpdateFunctionCode

  build.py --check   rc 0 when both literals match the zip of main.py, rc 1 otherwise
  build.py --write   rewrites both literals (run after editing main.py, then commit both files)
  build.py --print   prints the base64 of the zip
"""
import argparse
import base64
import hashlib
import io
import re
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "main.py"
COMPOSITIONS = HERE.parent / "recipes" / "serverless-compositions.yaml"
# Each key appears exactly once in the file, in the XLambdaFunction Composition.
LITERALS = {key: re.compile(r'^(\s*' + key + r': )"([A-Za-z0-9+/=]*)"$', re.M)
            for key in ("contentBase64", "sourceCodeHash")}


def zip_bytes(source=SOURCE):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
        info = zipfile.ZipInfo("main.py", date_time=(1980, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        info.create_system = 3
        zf.writestr(info, Path(source).read_bytes())
    return buf.getvalue()


def expected(source=SOURCE):
    z = zip_bytes(source)
    return {"contentBase64": base64.b64encode(z).decode(),
            "sourceCodeHash": base64.b64encode(hashlib.sha256(z).digest()).decode()}


def embedded(text):
    out = {}
    for key, rx in LITERALS.items():
        found = rx.findall(text)
        if len(found) != 1:
            raise SystemExit(f"{COMPOSITIONS.name}: expected exactly one {key} literal, found {len(found)}")
        out[key] = found[0][1]
    return out


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true")
    g.add_argument("--write", action="store_true")
    g.add_argument("--print", action="store_true")
    a = ap.parse_args()
    want = expected()
    if a.print:
        print(want["contentBase64"])
        return 0
    text = COMPOSITIONS.read_text()
    if a.write:
        for key, rx in LITERALS.items():
            text = rx.sub(lambda m, v=want[key]: f'{m.group(1)}"{v}"', text, count=1)
        COMPOSITIONS.write_text(text)
        print(f"build.py: wrote zip ({len(want['contentBase64'])} base64 chars) and sourceCodeHash {want['sourceCodeHash']}")
        return 0
    got = embedded(text)
    bad = [k for k in LITERALS if got[k] != want[k]]
    if bad:
        print(f"FAIL build.py: {', '.join(bad)} in {COMPOSITIONS.name} != zip of main.py (run build.py --write)")
        return 1
    print(f"build.py: embedded zip and sourceCodeHash == main.py ({len(want['contentBase64'])} base64 chars, "
          f"sha256 {want['sourceCodeHash']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
