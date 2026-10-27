"""platform_identity: quem é o caller, a partir do evento do API Gateway, em dois modos.

Único lugar do backend que sabe COMO a identidade chega (backstage-killer, passo 2b). As três
Lambdas (platform-api, cluster-api, platform-bff) chamam `caller_alias(event)`; o resto do código
só conhece o alias. Mode escolhido por env `AUTH_MODE`:

  iam (default, interno)  API Gateway com autorização IAM + SigV4 pelo the internal gateway. O alias é o nome da
                          sessão do `PortalInvokeRole` da conta esperada, lido de
                          `requestContext.identity.userArn` (REST) ou
                          `requestContext.authorizer.iam.userArn` (HTTP API).
  jwt (sample público)    API Gateway com authorizer JWT (Amazon Cognito ou qualquer OIDC). O
                          authorizer já validou assinatura, expiração, issuer e audience; aqui só se
                          extrai o alias das claims (`requestContext.authorizer.jwt.claims` na HTTP
                          API v2, `requestContext.authorizer.claims` no REST com Cognito authorizer)
                          e se aplicam dois controles extras, baratos e fail-closed: issuer esperado
                          (`AUTH_JWT_ISSUER`) e client ids permitidos (`AUTH_JWT_CLIENT_IDS`, vírgula).

Fail-closed por desenho: qualquer coisa fora do formato devolve alias vazio, e alias vazio é 403 em
todas as Lambdas. Nunca se lê `Authorization` cru aqui: quem valida token é o API Gateway.
"""
from __future__ import annotations

import os
import re
from typing import Any

ALIAS_PATTERN = re.compile(r"^[a-z][a-z0-9._-]{0,62}$")
MODES = ("iam", "jwt")


def mode() -> str:
    value = os.environ.get("AUTH_MODE", "iam").strip().lower() or "iam"
    if value not in MODES:
        raise RuntimeError(f"AUTH_MODE must be one of {MODES}, got {value!r}")
    return value


def _request_context(event: dict[str, Any]) -> dict[str, Any]:
    rc = event.get("requestContext")
    return rc if isinstance(rc, dict) else {}


def caller_arn(event: dict[str, Any]) -> str:
    """ARN do caller no modo iam (REST ou HTTP API). Vazio fora dele."""
    rc = _request_context(event)
    identity = rc.get("identity") if isinstance(rc.get("identity"), dict) else {}
    authorizer = rc.get("authorizer") if isinstance(rc.get("authorizer"), dict) else {}
    iam = authorizer.get("iam") if isinstance(authorizer.get("iam"), dict) else {}
    return str(identity.get("userArn") or iam.get("userArn") or "")


def iam_alias(event: dict[str, Any], *, account: str, role: str) -> str:
    """Nome da sessão do role esperado; vazio para qualquer outra identidade."""
    arn = caller_arn(event)
    prefix = f"arn:aws:sts::{account}:assumed-role/{role}/"
    if not arn.startswith(prefix):
        return ""
    # Comportamento idêntico ao gate anterior das três Lambdas: o nome da sessão é o alias, sem
    # normalização (o the internal gateway assume o role com o alias do usuário).
    return arn[len(prefix):].split("/", 1)[0]


def jwt_claims(event: dict[str, Any]) -> dict[str, Any]:
    """Claims já validadas pelo authorizer JWT (HTTP API v2) ou Cognito (REST). Vazio se não houver."""
    rc = _request_context(event)
    authorizer = rc.get("authorizer") if isinstance(rc.get("authorizer"), dict) else {}
    jwt = authorizer.get("jwt") if isinstance(authorizer.get("jwt"), dict) else {}
    claims = jwt.get("claims") if isinstance(jwt.get("claims"), dict) else authorizer.get("claims")
    return claims if isinstance(claims, dict) else {}


def jwt_alias(event: dict[str, Any], *, issuer: str = "", client_ids: frozenset[str] = frozenset(),
              alias_claim: str = "") -> str:
    """Alias a partir das claims. Controles: issuer igual ao esperado (se configurado), `client_id`
    ou `aud` dentro dos permitidos (se configurados), claim de alias no formato DNS-ish."""
    claims = jwt_claims(event)
    if not claims:
        return ""
    if issuer and str(claims.get("iss") or "") != issuer:
        return ""
    if client_ids:
        aud = claims.get("aud")
        audiences = {str(a) for a in aud} if isinstance(aud, list) else {str(aud)} if aud else set()
        if str(claims.get("client_id") or "") not in client_ids and not (audiences & client_ids):
            return ""
    # Sem fallback para `sub`: UUID não é alias (ownership, notificações e o `_ALIAS` dos eventos
    # exigem um nome legível que comece por letra). Token sem claim de nome é anônimo.
    # `cognito:username` vem no ID token; o ACCESS token do Cognito traz `username`. O portal manda o
    # access token (é o que o authorizer valida por client_id), então os dois nomes são aceitos.
    for key in ([alias_claim] if alias_claim else []) + ["cognito:username", "username", "preferred_username", "email"]:
        raw = str(claims.get(key) or "").strip().lower()
        if not raw:
            continue
        alias = raw.split("@", 1)[0] if key == "email" else raw
        return alias if ALIAS_PATTERN.fullmatch(alias) else ""
    return ""


def caller_alias(event: dict[str, Any]) -> str:
    """O alias do caller no modo configurado. Vazio = não autenticado para o gate das Lambdas."""
    if mode() == "jwt":
        client_ids = frozenset(c.strip() for c in os.environ.get("AUTH_JWT_CLIENT_IDS", "").split(",") if c.strip())
        return jwt_alias(event, issuer=os.environ.get("AUTH_JWT_ISSUER", "").strip(), client_ids=client_ids,
                         alias_claim=os.environ.get("AUTH_JWT_ALIAS_CLAIM", "").strip())
    return iam_alias(event, account=os.environ.get("EXPECTED_ACCOUNT", "111122223333"),
                     role=os.environ.get("EXPECTED_ROLE", "PortalInvokeRole"))
