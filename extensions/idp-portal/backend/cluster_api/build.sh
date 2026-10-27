#!/bin/bash
# Empacota a cluster-api. Alem do handler, leva:
#   - tool_catalog.json, copia de platform/agent-builder/tool-catalog.json, para
#     o inventario de tools conferir o catalogo sem depender da tupla embutida;
#   - agent_builder/, o nucleo do W1, quando ele existe, para o dry-run poder
#     compilar um draft. Sem ele a rota de draft responde 501, de proposito;
#   - standards.json, copia de platform/scorecards/standards.json (scorecards);
#   - platform_scope/ + registry.json (issue #10). Obrigatório: sem registry toda rota com
#     escopo responderia 503, então o build recusa em vez de gerar um bundle quebrado.
# Zip deterministico: timestamp fixo, entradas em ordem.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
OUT="$ROOT/.build"
mkdir -p "$OUT"
python3 - "$ROOT/lambda_function.py" "$OUT/cluster-api.zip" \
  "$REPO/platform/agent-builder/tool-catalog.json" "$REPO/backend/agent_builder" \
  "$REPO/backend/platform_scope" "$REPO/platform/scope/registry.json" \
  "$REPO/platform/scorecards/standards.json" <<'PY'
import json, pathlib, sys, zipfile

handler, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
catalog, core = pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4])
scope, registry = pathlib.Path(sys.argv[5]), pathlib.Path(sys.argv[6])
standards = pathlib.Path(sys.argv[7])
if not (scope / "__init__.py").is_file() or not registry.is_file():
    raise SystemExit("platform_scope or platform/scope/registry.json missing: refusing to build")
# Scorecards: as regras viajam no bundle. Sem o arquivo (ou com JSON quebrado) a Lambda subiria
# com os scorecards desligados em silêncio, então o build recusa.
if not standards.is_file():
    raise SystemExit("platform/scorecards/standards.json missing: refusing to build")
json.loads(standards.read_text(encoding="utf-8"))

members: list[tuple[str, bytes]] = [("lambda_function.py", handler.read_bytes())]
if catalog.is_file():
    members.append(("tool_catalog.json", catalog.read_bytes()))
if core.is_dir():
    for source in sorted(core.iterdir()):
        if source.suffix in {".py", ".json"}:
            members.append((f"agent_builder/{source.name}", source.read_bytes()))
members += [(f"platform_scope/{source.name}", source.read_bytes())
            for source in sorted(scope.iterdir()) if source.suffix == ".py"]
# Trilha de eventos (audit-log/notifications): mesmo pacote que a platform-api embarca.
events = scope.parent / "platform_events"
if not (events / "__init__.py").is_file():
    raise SystemExit("backend/platform_events missing: refusing to build")
members += [(f"platform_events/{source.name}", source.read_bytes())
            for source in sorted(events.iterdir()) if source.suffix == ".py"]
# Identidade do caller (backstage-killer 2b): mesmo adapter que as outras duas Lambdas embarcam.
identity = scope.parent / "platform_identity"
if not (identity / "__init__.py").is_file():
    raise SystemExit("backend/platform_identity missing: refusing to build")
members += [(f"platform_identity/{source.name}", source.read_bytes())
            for source in sorted(identity.iterdir()) if source.suffix == ".py"]
members.append(("platform_scope/registry.json", registry.read_bytes()))
members.append(("standards.json", standards.read_bytes()))

with zipfile.ZipFile(target, "w") as archive:
    for name, payload in sorted(members):
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, payload)
print(f"packed {len(members)} file(s)", file=sys.stderr)
PY
echo "$OUT/cluster-api.zip"
