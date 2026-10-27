"""Who may publish what. Deterministic, fail closed, no I/O.

The session alias comes from the platform-api (the internal gateway sets it server-side, a browser cannot
forge it). Team membership comes from `SERVICE_OWNER_TEAMS`, a JSON object
`{"<team>": ["alias", ...]}` the platform team controls by redeploy. An unset or unreadable
value denies everyone except platform admins: a Service Owner role that cannot be read is
not granted by default.

| op | who |
|---|---|
| create, evolve, deprecate | a member of the draft's owner team, or an admin |
| evolve, deprecate of another team's package | admin only (ownership transfer is a review) |
| retire | admin only |
"""
from __future__ import annotations

import json
import re
from typing import Any, Mapping

from .contract import OP_CREATE, OP_RETIRE, OPS, Issue

_ALIAS = re.compile(r"[a-z][a-z0-9._-]{0,63}")


def parse_teams(raw: str | None) -> dict[str, frozenset[str]]:
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    teams: dict[str, frozenset[str]] = {}
    for team, members in data.items():
        if isinstance(team, str) and isinstance(members, list):
            # "*" is never honoured here: a wildcard Service Owner is every team member.
            teams[team] = frozenset(m for m in members if isinstance(m, str) and _ALIAS.fullmatch(m))
    return teams


def authorize(alias: str, is_admin: bool, op: Any, owner: Any, base_owner: Any,
              teams: Mapping[str, frozenset[str]]) -> Issue | None:
    """None when allowed, else the refusal. `base_owner` is the owner on main (None on create)."""
    if not isinstance(alias, str) or not _ALIAS.fullmatch(alias):
        return Issue.of("", "unauthorized")
    if op not in OPS:
        return Issue.of("/op", "enum")
    if is_admin:
        return None
    if op == OP_RETIRE:
        return Issue.of("/op", "admin_only")
    if op != OP_CREATE and base_owner is not None and base_owner != owner:
        return Issue.of("/owner", "admin_only")
    if not isinstance(owner, str) or alias not in teams.get(owner, frozenset()):
        return Issue.of("/owner", "unauthorized")
    return None
