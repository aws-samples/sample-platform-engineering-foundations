"""ProjectDirectory backed by the project scope registry (issue #10, ADR-0009).

`StaticProjects` was the stand-in until #10 landed. This adapter answers the same question,
"what can this alias do in this project", from `platform_scope`, the single implementation of
the rule that the cluster-api and the platform-api already share. Nothing here reads the browser:
the alias is the the internal gateway session, the project comes from the registry packed in the Lambda.

Mapping, decided here and nowhere else:

| platform_scope role | assistant role | writes |
|---|---|---|
| admin | owner | yes |
| contributor | developer | yes |
| viewer | viewer | no |

A project that is not `active` maps every role to `viewer`, so a read-only project can be read
and never written. The assistant compiles kro instances into `platform/instances`, so a project
whose GitOps directory is another one (the Agent Builder project writes `platform/agents`) is
refused explicitly instead of producing a manifest the Argo CD Application would never apply.
"""
from __future__ import annotations

from typing import Any, Callable

from .planner import INSTANCE_PATH
from .ports import Membership, StaticProjects
from .service import AssistantError

ROLE_MAP = {"admin": "owner", "contributor": "developer", "viewer": "viewer"}
INSTANCE_DIRECTORY = INSTANCE_PATH.rsplit("/", 1)[0]


class ScopeProjects:
    """`membership()` over a parsed `platform_scope.Registry`. `is_admin_for(alias)` answers from
    PLATFORM_ADMINS for ANY alias, never from a request field: the same directory re-checks the
    plan's requester and the rollback's confirmer at write time, and the caller being an admin
    must never make a third party look like one."""

    def __init__(self, registry: Any, is_admin_for: Callable[[str], bool], role_for: Any):
        self._registry, self._is_admin_for, self._role_for = registry, is_admin_for, role_for

    def membership(self, project: str, alias: str) -> Membership | None:
        found = self._registry.project(project)
        role = self._role_for(found, alias, self._is_admin_for(alias)) if found else None
        if found is None or role is None:
            # Same answer as a project that does not exist: ids cannot be probed.
            return None
        if found.gitops_path != INSTANCE_DIRECTORY:
            raise AssistantError(403, "project_not_supported",
                                 f"the assistant writes {INSTANCE_DIRECTORY}; project {project} uses {found.gitops_path}")
        if len(found.namespaces) != 1:
            raise AssistantError(409, "namespace_ambiguous",
                                 f"project {project} has several namespaces; the assistant needs exactly one")
        mapped = ROLE_MAP[role] if found.lifecycle == "active" else "viewer"
        return Membership(found.id, alias, mapped, StaticProjects.PERSONAS[mapped], found.namespaces[0])
