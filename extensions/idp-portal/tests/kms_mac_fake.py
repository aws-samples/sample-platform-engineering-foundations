"""Fake KMS for the removal approval (HMAC_SHA_256), shared by every suite that touches a removal.

Real HMAC-SHA-256 with a random key per process, so a test can only produce a valid MAC by calling
`generate_mac`, exactly like production, where only the platform-api role may. `verify_mac` answers
like KMS: MacValid on success, KMSInvalidMacException on a wrong tag. `down` simulates KMS
unavailable and `calls` records every operation, so a test can assert who signed and who verified.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

KEY_ALIAS = "alias/appmod-assistant-removal-approval"
KEY_ARN = "arn:aws:kms:sa-east-1:111122223333:key/0b6f1e2a-1111-4222-8333-944455556666"


class KMSInvalidMacException(Exception):
    def __init__(self):
        super().__init__("KMSInvalidMacException")
        self.response = {"Error": {"Code": "KMSInvalidMacException"}}


class KmsUnavailable(Exception):
    def __init__(self, code: str = "ServiceUnavailableException"):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeKms:
    KEYS = {KEY_ALIAS, KEY_ARN}

    def __init__(self):
        self._secret = secrets.token_bytes(32)
        self.calls: list[tuple[str, str]] = []
        self.down = False

    def _mac(self, message: bytes) -> bytes:
        return hmac.new(self._secret, message, hashlib.sha256).digest()

    def _gate(self, op: str, key_id: str, algorithm: str) -> None:
        self.calls.append((op, key_id))
        if self.down:
            raise KmsUnavailable()
        if key_id not in self.KEYS:
            raise KmsUnavailable("NotFoundException")
        if algorithm != "HMAC_SHA_256":
            raise KmsUnavailable("InvalidKeyUsageException")

    def generate_mac(self, KeyId, Message, MacAlgorithm):  # noqa: N803 - boto3 names
        self._gate("GenerateMac", KeyId, MacAlgorithm)
        return {"Mac": self._mac(Message), "MacAlgorithm": MacAlgorithm, "KeyId": KEY_ARN}

    def verify_mac(self, KeyId, Message, Mac, MacAlgorithm):  # noqa: N803 - boto3 names
        self._gate("VerifyMac", KeyId, MacAlgorithm)
        if not hmac.compare_digest(self._mac(Message), Mac):
            raise KMSInvalidMacException()
        return {"KeyId": KEY_ARN, "MacValid": True, "MacAlgorithm": MacAlgorithm}


KMS = FakeKms()  # one key for the whole test run: what the platform-api signs, the CI verifies
