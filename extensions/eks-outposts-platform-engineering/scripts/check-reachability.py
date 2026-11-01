#!/usr/bin/env python3
"""Every committed file of the extension is reachable from README.md, and no two files have the same content.

Reachability is a graph walk that starts at README.md. A file reaches another file when it:
  - links it with a relative Markdown link, resolved from the linking file;
  - names its path in text (`platform/...`, `scripts/...`, `infrastructure/...`, `docs/...`, `../x`, `./x`), relative
    to the extension root or to the naming file;
  - names a directory: only its README.md is reached;
  - consumes a whole directory: the ApplicationSet declares `path: <dir>` (an Argo CD directory Application),
    `unittest discover -s <dir>` names the directory of a test suite, a Terraform `source = "./<dir>"` names a
    module, or a shell glob `<dir>/*.<ext>` names the files with that extension;
  - is the ApplicationSet and declares `values: <file>` (relative to platform/);
  - names a path through a shell or Terraform variable (`$ROOT/x`, `$HERE/x`, `${path.module}/x`): the part after
    the variable is resolved like any other path.
Two structural rules complete the walk: reaching a Terraform file reaches every `.tf` file of its module directory
(Terraform loads them together), and reaching a directory reaches its `README.md`. `.gitignore` and `CHANGELOG.md`
are entry points next to README.md. This checker contributes no edge, so the paths in its own mutation controls cannot reach anything. Any
committed file that the walk does not reach is an orphan. Identical content
in two paths is a duplicate, except Terraform `versions.tf` files, which every module must carry.

  python3 scripts/check-reachability.py [root]        rc 0 = no orphan, no duplicate, every mutation detected
"""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Files that predate this contract and no other file names. Each entry states why it exists and is verified below,
# so an entry cannot outlive its reason.
KNOWN_UNREFERENCED = {
    "platform/components/coredns/Corefile": "readable copy of the corefile embedded in configuration-values.json",
}
TEXT = {".md", ".sh", ".py", ".yaml", ".yml", ".json", ".tf", ".tftpl", ".txt", ".lock", ".example", ".drawio", ""}
SKIP_DIRS = {".git", ".runtime", ".terraform", "__pycache__"}
LINK = re.compile(r"\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)")
PATHISH = re.compile(r"(?<![\w./-])((?:\.{1,2}/)*(?:[\w.-]+/)*[\w.-]+(?:/|\.[A-Za-z0-9]+)?)")
APPSET_REF = re.compile(r"\b(?:path|values): ([\w./-]+)")
DISCOVER = re.compile(r"discover -s \"?(?:\$\{?ROOT\}?/)?([\w./-]+)")
TF_SOURCE = re.compile(r'\bsource\s*=\s*"(\.{1,2}/[\w./-]+)"')
GLOB = re.compile(r"((?:[\w.-]+/)+)\*(\.[A-Za-z0-9]+)\b")


def committed(root):
    """Files under git control when the root is a checkout; otherwise every file outside the skipped directories."""
    try:
        out = subprocess.run(["git", "-C", str(root), "ls-files", "-z", "--", "."], capture_output=True, check=True).stdout
        prefix = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-prefix"], capture_output=True, text=True,
                                check=True).stdout.strip()
        files = [p[len(prefix):] if p.startswith(prefix) else p for p in out.decode().split("\0") if p]
        if files:
            return sorted(root / p for p in files if (root / p).is_file())
    except (OSError, subprocess.CalledProcessError):
        pass
    return sorted(p for p in root.rglob("*") if p.is_file() and not SKIP_DIRS & set(p.relative_to(root).parts))


def readable(path):
    if path.suffix not in TEXT:
        return None
    try:
        return path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None


def targets(root, path, text, universe):
    out, whole = set(), []
    if path.name == "applicationset.yaml":
        whole += [("platform/" + m.group(1), None) for m in APPSET_REF.finditer(text)]
    whole += [(m.group(1), ".py") for m in DISCOVER.finditer(text)]
    if path.suffix == ".tf":
        whole += [(m.group(1), ".tf") for m in TF_SOURCE.finditer(text)]
    whole += [(re.sub(r"^.*?(?:ROOT|HERE)\}?/", "", m.group(1)), m.group(2)) for m in GLOB.finditer(text)]
    text = re.sub(r"\$\{?(?:HERE|path\.module)\}?/", " ./", text)
    text = re.sub(r"\$\{?ROOT\}?/", " ", text)
    names = [m.group(1) for m in PATHISH.finditer(text)]
    candidates = [m.group(1) for m in LINK.finditer(text)] + [n for n in names if "/" in n]
    candidates += ["./" + n for n in names if "/" not in n and "." in n.strip(".")]
    for raw, suffix in whole:
        for base in (path.parent, root):
            directory = (base / raw).resolve()
            if directory in universe:
                out.add(directory)
            elif directory.is_dir() and directory.is_relative_to(root):
                out.update(p for p in universe if p.parent == directory and (suffix is None or p.suffix == suffix))
    for raw in candidates:
        raw = raw.strip("`'\",;:)(")
        for base in (path.parent, root):
            target = (base / raw).resolve()
            if target in universe:
                out.add(target)
            elif target.is_dir() and (target / "README.md") in universe:
                out.add(target / "README.md")
    return out


def check(root):
    root = root.resolve()
    files = [p.resolve() for p in committed(root)]
    universe, findings = set(files), []
    seen, queue = set(), [root / "README.md", root / ".gitignore", root / "CHANGELOG.md"]
    while queue:
        current = queue.pop()
        if current in seen or current not in universe:
            continue
        seen.add(current)
        text = readable(current) if current != root / "scripts" / "check-reachability.py" else None
        if text is not None:
            queue.extend(targets(root, current, text, universe) - seen)
        if current.suffix == ".tf":
            queue.extend(p for p in universe if p.parent == current.parent and p.suffix == ".tf" and p not in seen)
        index = current.parent / "README.md"
        if index in universe and index not in seen:
            queue.append(index)
    for relative, reason in KNOWN_UNREFERENCED.items():
        corefile, values = root / relative, root / "platform/components/coredns/configuration-values.json"
        if not (corefile.is_file() and values.is_file() and json.loads(values.read_text()).get("corefile") == corefile.read_text()):
            findings.append(f"known unreferenced file lost its reason: {relative} ({reason})")
        seen.add(corefile.resolve())
    findings += [f"orphan: {p.relative_to(root)}" for p in files if p not in seen]
    digests = {}
    for p in files:
        digests.setdefault(hashlib.sha256(p.read_bytes()).hexdigest(), []).append(str(p.relative_to(root)))
    findings += [f"duplicate content: {', '.join(paths)}" for paths in digests.values()
                 if len(paths) > 1 and not all(Path(x).name == "versions.tf" for x in paths)]
    return findings, len(files), len(seen)


def erase(root, *tokens):
    """Removes every textual mention of the tokens from every readable file of a copy."""
    for path in root.rglob("*"):
        text = readable(path) if path.is_file() else None
        if text is not None:
            for token in tokens:
                text = text.replace(token, "erased-reference")
            path.write_text(text, encoding="utf-8")


def mutation_controls(root):
    def orphan(t):
        (t / "platform" / "components" / "orphan-component").mkdir(parents=True)
        (t / "platform" / "components" / "orphan-component" / "unused.yaml").write_text("kind: ConfigMap\n")
        return "orphan: platform/components/orphan-component/unused.yaml"

    def orphan_in_named_directory(t):
        (t / "platform" / "components" / "chaos-egress" / "leftover.yaml").write_text("kind: ConfigMap\n")
        return "orphan: platform/components/chaos-egress/leftover.yaml"

    def duplicate(t):
        shutil.copy(t / "platform" / "apps" / "retail-store" / "namespace.yaml", t / "platform" / "components" / "copy.yaml")
        (t / "README.md").write_text((t / "README.md").read_text() + "\nSee `platform/components/copy.yaml`.\n")
        return "duplicate content: platform/apps/retail-store/namespace.yaml, platform/components/copy.yaml"

    def unnamed_test(t):
        erase(t, "test_queries_doc.py")
        return "orphan: platform/components/observability/connectivity/tests/test_queries_doc.py"

    def dashboard_unapplied(t):
        erase(t, "components/observability/dashboards", "platform-connectivity-dashboard.yaml", '"dashboards"')
        return "orphan: platform/components/observability/dashboards/platform-connectivity-dashboard.yaml"

    passed = 0
    for name, mutate in (("orphan file", orphan), ("orphan in a named directory", orphan_in_named_directory),
                         ("duplicate file", duplicate), ("test no longer named", unnamed_test),
                         ("dashboard no longer applied", dashboard_unapplied)):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "extension"
            shutil.copytree(root, target, ignore=shutil.ignore_patterns(*SKIP_DIRS))
            expected = mutate(target)
            if expected not in check(target)[0]:
                raise AssertionError(f"mutation was not detected: {name} (expected {expected!r})")
            passed += 1
    return passed


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]).resolve()
    findings, total, reached = check(root)
    for finding in findings:
        print(f"FAIL {finding}")
    if findings:
        print(f"RESULT reachability files={total} reached={reached} failures={len(findings)}")
        return 1
    controls = mutation_controls(root)
    print(f"PASS reachability files={total} reached={reached} duplicates=0 mutation-controls={controls}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
