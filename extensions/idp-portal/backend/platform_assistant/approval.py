"""Cryptographic approval of a confirmed Platform Assistant removal (KMS HMAC, threat model T-R1).

Why it exists: the CI role `GitLab` is trusted by GitLab:Project and GitLab:Group only, with no
condition on the ref, and it holds `dynamodb:UpdateItem` on the provision table. A pipeline of ANY
branch can therefore write a plan record and an `assistant-removal` request that look exactly like
the ones the platform-api writes, and git authorship and MR labels are forgeable too. The one
thing such a pipeline cannot produce is a MAC under a KMS key that only the platform-api execution
role may use with `kms:GenerateMac`. The CI role may only `kms:VerifyMac`.

    message = canonical_message(item)            # versioned, deterministic bytes, <= 4096 bytes
    item.update(sign(item, KmsMac(kms, key).generate))   # platform-api, after the human confirmed
    problem = check(record, KmsMac(kms, key).verify, now)  # CI and mirror, before any delete

Stdlib only and free of package-relative imports: the GitOps mirror job has no backend on its
PYTHONPATH and loads this file by path, so the canonical form has exactly one implementation.
Every failure is closed: no key configured, KMS unreachable or an unexpected answer raise
ApprovalUnavailable, which callers treat as "do not delete", never as "valid".
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Any, Callable, Mapping

PROOF_VERSION = "assistant-removal-approval/v1"
MAC_ALGORITHM = "HMAC_SHA_256"
MAC_BYTES = 32
KEY_ENV = "ASSISTANT_REMOVAL_KEY_ID"
REMOVAL_KIND = "assistant-removal"  # ports.REMOVAL_KIND; tests pin one to the other
REMOVAL_OP = "remove"
SIGNED_TEXT = ("requestId", "kind", "op", "planId", "planStep", "name", "path", "requester", "confirmer")
SIGNED_NUMBER = ("issuedAt", "expiresAt")
PROOF_TEXT = ("proofVersion", "macAlgorithm", "mac")
# A removal request lives 30 days (runs.REQUEST_TTL_SECONDS); one day of slack, never more.
MAX_LIFETIME_SECONDS = 31 * 24 * 3600
CLOCK_SKEW_SECONDS = 300
MAX_MESSAGE_BYTES = 4096  # the GenerateMac/VerifyMac message limit
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class ApprovalUnavailable(RuntimeError):
    """The proof could not be produced or checked. Never the same thing as a valid proof."""


def canonical_message(fields: Mapping[str, Any]) -> bytes:
    """The exact bytes that are MACed. ValueError when a signed field is missing or malformed.

    Versioned (`proofVersion` is inside the signed object), sorted keys, no whitespace, ASCII only,
    so the platform-api, the CI and the mirror derive the same bytes from the same record.
    """
    payload: dict[str, Any] = {"proofVersion": PROOF_VERSION}
    for key in SIGNED_TEXT:
        value = fields.get(key)
        if not isinstance(value, str) or not value or _CONTROL.search(value):
            raise ValueError(f"signed field {key} is missing or not a clean string")
        payload[key] = value
    for key in SIGNED_NUMBER:
        value = fields.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"signed field {key} is missing or not a positive integer")
        payload[key] = value
    if payload["kind"] != REMOVAL_KIND or payload["op"] != REMOVAL_OP:
        raise ValueError("only an assistant-removal request carries an approval proof")
    message = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if len(message) > MAX_MESSAGE_BYTES:
        raise ValueError(f"canonical message is {len(message)} bytes, over the {MAX_MESSAGE_BYTES} KMS limit")
    return message


def sign(fields: Mapping[str, Any], generate_mac: Callable[[bytes], bytes] | None) -> dict[str, str]:
    """Proof fields to persist next to the request. `generate_mac` is KmsMac.generate in production."""
    if generate_mac is None:
        raise ApprovalUnavailable(f"no approval signer is configured ({KEY_ENV})")
    try:
        message = canonical_message(fields)
    except ValueError as error:
        raise ApprovalUnavailable(f"refusing to sign: {error}") from None
    mac = generate_mac(message)
    if not isinstance(mac, bytes) or len(mac) != MAC_BYTES:
        raise ApprovalUnavailable("the signer returned something that is not an HMAC-SHA-256 tag")
    return {"proofVersion": PROOF_VERSION, "macAlgorithm": MAC_ALGORITHM, "mac": base64.b64encode(mac).decode("ascii")}


def check(fields: Mapping[str, Any], verify_mac: Callable[[bytes, bytes], bool] | None, now: int) -> str:
    """'' when the record carries a valid, unexpired approval; otherwise why not.

    Raises ApprovalUnavailable when the verification itself could not run (no verifier, KMS down):
    callers keep the file, they never read that as an approval.
    """
    if fields.get("proofVersion") != PROOF_VERSION:
        return f"the removal carries no approval proof of version {PROOF_VERSION}"
    if fields.get("macAlgorithm") != MAC_ALGORITHM:
        return f"the approval proof does not use {MAC_ALGORITHM}"
    try:
        mac = base64.b64decode(str(fields.get("mac") or ""), validate=True)
    except (binascii.Error, ValueError):
        return "the approval MAC is not base64"
    if len(mac) != MAC_BYTES:
        return "the approval MAC is not an HMAC-SHA-256 tag"
    try:
        message = canonical_message(fields)
    except ValueError as error:
        return f"the approved fields are malformed: {error}"
    issued, expires = int(fields["issuedAt"]), int(fields["expiresAt"])
    if expires <= now:
        # L1: an expired approval never authorizes a delete, even while the item still exists
        # because the DynamoDB TTL sweeper has not physically removed it yet.
        return f"the approval expired at {expires} (now {now})"
    if issued > now + CLOCK_SKEW_SECONDS:
        return "the approval was issued in the future"
    if expires <= issued or expires - issued > MAX_LIFETIME_SECONDS:
        return "the approval lifetime is out of bounds"
    if verify_mac is None:
        raise ApprovalUnavailable(f"no approval verifier is configured ({KEY_ENV})")
    if not verify_mac(message, mac):
        return "the approval MAC does not verify under the removal approval key"
    return ""


def record_fields(item: Mapping[str, Any]) -> dict[str, Any]:
    """The signed and proof fields of a low-level DynamoDB item ({"S": ...} / {"N": ...})."""
    found: dict[str, Any] = {}
    for key in (*SIGNED_TEXT, *PROOF_TEXT):
        value = (item.get(key) or {}).get("S") if isinstance(item.get(key), dict) else None
        if isinstance(value, str):
            found[key] = value
    for key in SIGNED_NUMBER:
        raw = (item.get(key) or {}).get("N") if isinstance(item.get(key), dict) else None
        if isinstance(raw, str) and re.fullmatch(r"[0-9]{1,12}", raw):
            found[key] = int(raw)
    return found


def _error_code(error: Exception) -> str:
    response = getattr(error, "response", None)
    code = ((response or {}).get("Error") or {}).get("Code") if isinstance(response, dict) else None
    return str(code or type(error).__name__)


class KmsMac:
    """Adapter over an injected boto3 KMS client. GenerateMac in the platform-api, VerifyMac in the CI.

    The key never leaves KMS and no secret lives in an environment variable: the environment only
    names the key (ARN in the platform-api, alias in the CI) and IAM decides who may use it.
    """

    def __init__(self, client: Any, key_id: str):
        self._client, self._key = client, (key_id or "").strip()

    def _require(self) -> None:
        if not self._key or self._client is None:
            raise ApprovalUnavailable(f"{KEY_ENV} is not configured: no removal can be approved or verified")

    def generate(self, message: bytes) -> bytes:
        self._require()
        try:
            answer = self._client.generate_mac(KeyId=self._key, Message=message, MacAlgorithm=MAC_ALGORITHM)
        except Exception as error:  # noqa: BLE001 - any KMS failure is "cannot sign", never a tag
            raise ApprovalUnavailable(f"kms:GenerateMac failed ({_error_code(error)})") from None
        if not isinstance(answer, dict) or answer.get("MacAlgorithm") != MAC_ALGORITHM \
                or not isinstance(answer.get("Mac"), bytes):
            raise ApprovalUnavailable("kms:GenerateMac answered an unexpected shape")
        return answer["Mac"]

    def verify(self, message: bytes, mac: bytes) -> bool:
        self._require()
        try:
            answer = self._client.verify_mac(KeyId=self._key, Message=message, Mac=mac, MacAlgorithm=MAC_ALGORITHM)
        except Exception as error:  # noqa: BLE001 - only an invalid MAC is a "no"; anything else is unknown
            if _error_code(error) == "KMSInvalidMacException":
                return False
            raise ApprovalUnavailable(f"kms:VerifyMac failed ({_error_code(error)})") from None
        return isinstance(answer, dict) and answer.get("MacValid") is True and answer.get("MacAlgorithm") == MAC_ALGORITHM
