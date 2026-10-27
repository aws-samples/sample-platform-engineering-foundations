#!/bin/bash
# Empacota a platform-api com os núcleos stdlib que ela importa, todos do repo, sem cópia:
#   - agent_builder/ (inclusive tool-catalog.json): preview e pedido kagent-agent;
#   - platform_scope/ + registry.json (issue #10): sem registry toda rota com escopo responde 503;
#   - service_studio/ + compositions/*-rgd.yaml (issue #11): o Studio amarra o formulário a uma
#     composition existente e responde 503 sem elas;
#   - platform_assistant/ + capability-index.json (issue #12): sem o índice nenhum plano é aceito.
# Cada ausência recusa o build em vez de gerar um bundle que falharia só em produção.
# Zip determinístico: timestamp fixo, ordem fixa.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
OUT="$ROOT/.build"
mkdir -p "$OUT"
python3 -m py_compile "$ROOT/lambda_function.py"
python3 - "$ROOT/lambda_function.py" "$OUT/platform-api.zip" "$REPO" <<'PY'
import pathlib, sys, zipfile
handler, target, repo = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
backend = repo / "backend"


def package(name: str, suffixes: set[str]) -> list[tuple[str, bytes]]:
    source = backend / name
    if not (source / "__init__.py").is_file():
        raise SystemExit(f"backend/{name} missing: refusing to build")
    return [(f"{name}/{p.name}", p.read_bytes()) for p in sorted(source.iterdir()) if p.is_file() and p.suffix in suffixes]


members = [("lambda_function.py", handler.read_bytes())]
members += package("agent_builder", {".py", ".json"})
members += package("platform_scope", {".py"})
members += package("service_studio", {".py"})
members += package("platform_assistant", {".py", ".json"})
members += package("platform_events", {".py"})
members += package("platform_identity", {".py"})
registry = repo / "platform/scope/registry.json"
if not registry.is_file():
    raise SystemExit("platform/scope/registry.json missing: refusing to build")
members.append(("platform_scope/registry.json", registry.read_bytes()))
compositions = sorted((repo / "platform/compositions").glob("*-rgd.yaml"))
if not compositions:
    raise SystemExit("platform/compositions/*-rgd.yaml missing: refusing to build the Service Owner Studio")
members += [(f"service_studio/compositions/{p.name}", p.read_bytes()) for p in compositions]
names = {name for name, _ in members}
for required in ("agent_builder/tool-catalog.json", "platform_assistant/capability-index.json"):
    if required not in names:
        raise SystemExit(f"{required} missing: refusing to build")
with zipfile.ZipFile(target, "w") as archive:
    for name, payload in sorted(members):
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, payload)
print(f"packed {len(members)} file(s)", file=sys.stderr)
PY
echo "$OUT/platform-api.zip"
