#!/usr/bin/env python3
import re
import shlex
import sys
from pathlib import Path

ENTRY_PATH = re.compile(r"(?:\$ROOT|\.{0,2}|[A-Za-z0-9_.-]+)/(?:[^\s`'\";&|()]+/)*[^\s`'\";&|()]+\.(?:sh|py)|(?:^|(?<=\s))[A-Za-z0-9_.-]+\.(?:sh|py)")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
CONTROL = {"!", "do", "elif", "if", "then", "until", "while", "{"}
INTERPRETER = {".sh": "bash", ".py": "python3"}

def direct_shell_commands(line: str) -> list[str]:
    findings = []
    for segment in re.split(r"\|\||&&|[;|]", line):
        try:
            tokens = shlex.split(segment, comments=True, posix=True)
        except ValueError:
            continue
        while tokens and tokens[0] in CONTROL:
            tokens.pop(0)
        if tokens and tokens[0] == "env":
            tokens.pop(0)
        while tokens and ASSIGNMENT.match(tokens[0]):
            tokens.pop(0)
        if tokens and tokens[0] == "command":
            tokens.pop(0)
        if tokens and Path(tokens[0]).suffix in INTERPRETER:
            findings.append(tokens[0])
    return findings

def direct_markdown_commands(text: str) -> list[tuple[int, str]]:
    findings = []
    text = re.sub(r"\[[^]]+\]\([^)]*\.(?:sh|py)(?:#[^)]*)?\)", "", text)
    for line_number, line in enumerate(text.splitlines(), 1):
        snippets = re.findall(r"`([^`]*\.(?:sh|py)[^`]*)`", line)
        if line.lstrip().startswith(("bash ", "python3 ", "./", "../")) and re.search(r"\.(?:sh|py)(?:\s|$)", line):
            snippets.append(line.strip())
        for snippet in snippets:
            for match in ENTRY_PATH.finditer(snippet):
                suffix = Path(match.group(0)).suffix
                prefix = snippet[:match.start()].rstrip()
                if not re.search(r"(?:^|\s)" + INTERPRETER[suffix] + r"$", prefix):
                    findings.append((line_number, match.group(0)))
    return findings

def main() -> None:
    root = Path(sys.argv[1]).resolve()
    root_readme = Path(sys.argv[2]).resolve()
    findings = []
    for path in root.rglob("*"):
        if not path.is_file() or ".runtime" in path.parts:
            continue
        relative = path.relative_to(root)
        if path.suffix == ".sh":
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                for command in direct_shell_commands(line):
                    findings.append(f"{relative}:{line_number}:direct-entry-point:{command}")
        elif path.suffix == ".md":
            for line_number, command in direct_markdown_commands(path.read_text(encoding="utf-8")):
                findings.append(f"{relative}:{line_number}:direct-markdown:{command}")
    readme = root_readme.read_text(encoding="utf-8")
    matches = list(re.finditer(r"^## Related Demo:.*?(?=^## Contributing\s*$)", readme, re.MULTILINE | re.DOTALL))
    if len(matches) != 1:
        findings.append("README.md:related-demo-section-count")
    else:
        for line_number, command in direct_markdown_commands(matches[0].group(0)):
            findings.append(f"README.md:{line_number}:direct-markdown:{command}")
    assert direct_shell_commands('FOO=bar "$ROOT/scripts/example.sh"')
    assert direct_shell_commands('tools/example.py --check')
    assert not direct_shell_commands('FOO=bar bash "$ROOT/scripts/example.sh"')
    assert not direct_shell_commands('python3 tools/example.py --check')
    assert direct_markdown_commands('Run `scripts/example.sh now` and `tools/example.py now`.')
    assert not direct_markdown_commands('Run `bash scripts/example.sh now` and `python3 tools/example.py now`.')
    if findings:
        print("\n".join(findings))
        raise SystemExit(1)
    print("PASS entry-point invocation gate positive-controls=detected negative-controls=clean")

if __name__ == "__main__":
    main()
