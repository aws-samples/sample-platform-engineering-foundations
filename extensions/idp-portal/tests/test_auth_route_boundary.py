"""Fronteira de auth e rotas para a extension do aws-samples (backlog backstage-killer, passos 1 e 2).

O que se afirma aqui é ESTRUTURAL e não dá para afirmar num teste de componente:

- toda chamada a API do portal passa pelo auth adapter (`src/platform/auth/`): nenhum client fala
  com `window.harmony`, nem conhece URL de API Gateway, nem a role de invocação;
- o modo de auth é decidido no build por flavor (interno = harmony, oss = bearer), e as URLs vêm de
  `VITE_*` com default interno;
- as views do shell têm UMA fonte (`routes/routeRegistry.ts`); o shell, a busca e os títulos derivam.

Se um destes falhar, a extension volta a exigir edição em N arquivos para trocar de conta ou de login.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
AUTH_DIR = SRC / "platform" / "auth"


def source_files():
    for path in SRC.rglob("*.ts*"):
        if path.suffix not in (".ts", ".tsx") or path.name.endswith((".test.ts", ".test.tsx", ".d.ts")):
            continue
        yield path


def code(text: str) -> str:
    without_blocks = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return re.sub(r"^\s*//.*$", " ", without_blocks, flags=re.M)


def test_no_client_outside_auth_touches_harmony_or_hardcodes_an_api_url():
    offenders = []
    for path in source_files():
        if AUTH_DIR in path.parents:
            continue
        text = code(path.read_text())
        for token in ("registerApi", "execute-api.", "window.harmony", "HarmonyWindow"):
            if token in text:
                offenders.append(f"{path.relative_to(ROOT)}: {token}")
    assert offenders == [], offenders


def test_harmony_role_arn_lives_only_in_the_adapter_and_the_help_text():
    allowed = {"src/platform/auth/authAdapter.ts", "src/platform/HelpPage.tsx"}
    found = {str(p.relative_to(ROOT)) for p in source_files() if "PortalInvokeRole" in p.read_text()}
    assert found <= allowed, found - allowed


def test_every_client_imports_apiFetch_from_the_adapter():
    clients = [
        "src/platform/clusterApi.ts", "src/platform/platformApi.ts", "src/platform/kdpInventoryApi.ts",
        "src/platform/gatewayApi.ts", "src/platform/agentBuilderApi.ts", "src/platform/scope/scopeApi.ts",
        "src/platform/assistant/assistantApi.ts", "src/platform/serviceStudio/serviceStudioApi.ts",
    ]
    for client in clients:
        text = (ROOT / client).read_text()
        assert "apiFetch" in text and "auth/authAdapter'" in text, client


def test_endpoints_come_from_vite_env_with_internal_defaults():
    text = (AUTH_DIR / "endpoints.ts").read_text()
    for var in ("VITE_CLUSTER_API_URL", "VITE_PLATFORM_API_URL", "VITE_BFF_URL"):
        assert var in text, var
    env_decl = (SRC / "vite-env.d.ts").read_text()
    for var in ("VITE_AUTH_MODE", "VITE_CLUSTER_API_URL", "VITE_PLATFORM_API_URL", "VITE_BFF_URL", "VITE_HARMONY_ROLE_ARN"):
        assert var in env_decl, var


def test_auth_mode_defaults_per_flavor_in_the_vite_build():
    vite = (ROOT / "vite.config.ts").read_text()
    assert "'import.meta.env.VITE_AUTH_MODE'" in vite
    # repo fonte: default por flavor; extension exportada (um flavor): bearer fixo, override por env.
    assert "flavor === 'oss' ? 'bearer' : 'harmony'" in vite or "process.env.VITE_AUTH_MODE ?? 'bearer'" in vite
    adapter = (AUTH_DIR / "authAdapter.ts").read_text()
    assert "env.VITE_AUTH_MODE === 'bearer' ? 'bearer' : 'harmony'" in adapter


def test_shell_search_and_titles_derive_from_the_route_registry():
    shell = code((SRC / "platform/AgentPlatformPage.tsx").read_text())
    assert "const VALID_VIEWS: readonly View[] = VIEW_IDS;" in shell
    assert "type View = ViewId;" in shell
    assert re.search(r"type View = '[a-z-]+' \|", shell) is None, "lista paralela de views voltou ao shell"
    search = code((SRC / "platform/GlobalSearch.tsx").read_text())
    assert "SEARCHABLE_ROUTES" in search
    assert "{ view: 'home'," not in search, "lista paralela de páginas voltou à busca"
    nav = code((SRC / "platform/shellNavigation.ts").read_text())
    assert "titleOf(view, pt)" in nav
    assert "DRAFT_VIEWS: ReadonlySet<string> = DRAFT_VIEW_IDS" in nav
