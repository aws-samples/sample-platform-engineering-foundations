"""CI side of a compensation: turn an `assistant-removal` request into a delete merge request.

Pure function, no I/O, so the CI job (`open-provision-mrs`) can call it with the file it read
from `main` and the GitLab writes stay in the job, behind the same review gate as a creation.
It refuses to delete a file this plan did not write: the labels the compiler stamped must
still be there, byte for byte, or the removal fails closed and a human decides. The MR names who
CONFIRMED the rollback (`confirmer`), which is not necessarily who requested the plan.
"""
from __future__ import annotations

import json
import re
from typing import Any

from .planner import INSTANCE_PATH, NAME_PATTERN
from .ports import REMOVAL_KIND

CHECKLIST = """Aberto pelo Platform Assistant: rollback compensatório do plano `{plan_id}` de @{requester}, confirmado por @{confirmer}.

Checklist do ADR-0007:

| Item | Valor |
|---|---|
| Recurso | `{path}` ({capability}) |
| Criado por | este mesmo plano, passo `{step}` (labels `platform.appmod/plan-id` e `plan-step` conferidos na main) |
| Deletion policy efetiva | `{deletion}` |
| Efeito | {effect} |
| Recursos preexistentes | não são tocados: o plano só remove o que ele criou |

O bot nunca mergeia este MR. Aprove e mergeie para remover; feche para manter o recurso.
"""


class RemovalRefused(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _label(text: str, key: str) -> str:
    match = re.search(rf'^    platform\.appmod/{re.escape(key)}: "([^"\n]*)"$', text, flags=re.M)
    return match.group(1) if match else ""


def removal_change(item: dict[str, Any], main_file: str | None, *, deletion_policy: str, effect: str) -> dict[str, Any]:
    """Return the branch, the commit and the merge request payloads for a removal request."""
    if item.get("kind") != REMOVAL_KIND or item.get("op") != "remove":
        raise RemovalRefused("bad_kind", "not an assistant removal request")
    name = str(item.get("name", ""))
    confirmer = str(item.get("confirmer") or "")
    if not confirmer:
        raise RemovalRefused("not_confirmed", "the removal request does not name who confirmed it")
    if not NAME_PATTERN.fullmatch(name) or item.get("path") != INSTANCE_PATH.format(name=name):
        raise RemovalRefused("bad_path", "the path is not the instance path of the name")
    if main_file is None:
        raise RemovalRefused("not_found", f"{item['path']} is not on main; nothing to remove")
    if _label(main_file, "plan-id") != item.get("planId") or _label(main_file, "plan-step") != item.get("planStep") \
            or _label(main_file, "managed-by") != "platform-assistant":
        raise RemovalRefused("not_owned", f"{item['path']} on main was not written by plan {item.get('planId')}")
    request_id = str(item["requestId"])
    branch = f"rollback/{name}-{request_id[:8]}"
    return {
        "branch": branch,
        "commit": {"branch": branch, "start_branch": "main",
                   "commit_message": f"revert(provision): {name} via platform assistant\n\n"
                                     f"Compensation {request_id} of plan {item['planId']} of {item['requester']}, "
                                     f"confirmed by {confirmer}.",
                   "actions": [{"action": "delete", "file_path": item["path"]}]},
        "mergeRequest": {"source_branch": branch, "target_branch": "main", "remove_source_branch": True,
                         "labels": "provisioning,rollback",
                         "title": f"revert(provision): {name} ({item.get('capability', '-')})",
                         "description": CHECKLIST.format(plan_id=item["planId"], requester=item["requester"],
                                                         confirmer=confirmer,
                                                         path=item["path"], capability=item.get("capability", "-"),
                                                         step=item["planStep"], deletion=deletion_policy,
                                                         effect=json.dumps(effect, ensure_ascii=False)[1:-1])},
    }
