"""DynamoDB semantics of the CI claim and finish, shared by every fake table of the test suite.

The fakes used to pattern-match loosely (any ConditionExpression counted as a claim, and one fake
settled `finish` with no condition at all), so a regression in the ownership contract passed. Here
the two expressions of scripts/open_provision_mrs.py are matched EXACTLY and evaluated as DynamoDB
would, with ExpressionAttributeNames resolved; any other expression is an error, never a write.
"""
from __future__ import annotations

from typing import Any

CLAIM_CONDITION = "#s = :pending OR (#s = :processing AND claimedAt < :stale)"
CLAIM_UPDATE = "SET #s = :processing, claimedAt = :now, #cid = :claim"
FINISH_CONDITION = "#s = :claimed AND #cid = :claim"
NAMES = {"#s": "status", "#cid": "claimId"}


def _s(item: dict[str, Any] | None, key: str) -> str:
    return ((item or {}).get(key) or {}).get("S", "")


def is_claim(condition: str | None) -> bool:
    return condition == CLAIM_CONDITION


def is_finish(condition: str | None) -> bool:
    return condition == FINISH_CONDITION


def claim(item: dict[str, Any] | None, update: str, names: dict[str, str], values: dict[str, Any]) -> bool:
    """Apply the claim when its condition holds. False means ConditionalCheckFailed."""
    assert update == CLAIM_UPDATE and names == NAMES, (update, names)
    if not item:
        return False
    status = _s(item, "status")
    claimed = int(((item.get("claimedAt") or {}).get("N")) or 0) if "claimedAt" in item else None
    stale_retake = status == "processing" and claimed is not None and claimed < int(values[":stale"]["N"])
    if not (status == values[":pending"]["S"] or stale_retake):
        return False
    item["status"], item["claimedAt"], item["claimId"] = values[":processing"], values[":now"], values[":claim"]
    return True


def finish(item: dict[str, Any] | None, update: str, names: dict[str, str], values: dict[str, Any]) -> bool:
    """Apply the finish only over a live claim that still carries THIS run's token."""
    assert names == NAMES and update.startswith("SET #s = :status, "), (update, names)
    if not item or _s(item, "status") != values[":claimed"]["S"] or _s(item, "claimId") != values[":claim"]["S"]:
        return False
    item["status"] = values[":status"]
    item["mrUrl" if "mrUrl" in update else "error"] = values[":detail"]
    return True
