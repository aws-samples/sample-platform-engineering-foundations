"""Fixtures compartilhadas da suite.

As fixtures do AppMod Report Pipeline (guards SQL da Actions API, gerador do report,
ReportViewer) sairam em 28/09/2026 junto com o codigo que testavam: o pipeline roda
local desde 26/09 e a nuvem dele foi desmontada.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]


def internal_artifact(relative: str) -> Path:
    """Caminho de um artefato que só existe no repositório fonte (BFF, bot de MR do GitLab, Terraform e
    RBAC do deployment interno). A extension exportada (scripts/export-extension.py) não o carrega, então
    o teste PULA lá, com o motivo, em vez de falhar em arquivo ausente. No repositório fonte nunca pula."""
    path = REPO_ROOT / relative
    if not path.exists():
        pytest.skip(f"internal-only artifact not in this tree: {relative}")
    return path


@pytest.fixture(scope="session")
def harmony_metadata() -> dict:
    return json.loads((REPO_ROOT / ".harmony/harmony-metadata.json").read_text(encoding="utf-8"))
