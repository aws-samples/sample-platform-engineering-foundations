"""Trilha de eventos da plataforma: um store, dois consumidores.

- **Audit log** (quem fez o quê): toda ação governada escreve UM evento aqui, com ator, ação, objeto,
  resultado e hora. Lista geral para admin; por objeto no detalhe; por ator para o próprio.
- **Notificações**: o mesmo evento, filtrado para o usuário (ator é ele, ou o objeto está num projeto
  dele), com marca d'água de leitura por usuário e marca por evento.

Por que um store só: notificação É um evento de auditoria visto do lado de quem o recebe. Dois stores
divergiriam (o incidente clássico é a notificação dizer "merged" e a trilha não ter o merge).

Produtores (cada um grava o que ele mesmo decidiu, nunca o que inferiu do outro):
- platform-api: pedido de provisionamento criado, tour, pedido de agent/capability, plano do
  Assistant submetido/reexecutado/compensado;
- cluster-api: restart, scale, delete-pod (ações Day 2 governadas);
- CI (`scripts/open_provision_mrs.py`): MR aberto, merge confirmado, falha.

Regras:
- A ESCRITA é fail-open: falha ao gravar o evento NUNCA desfaz nem esconde a ação (ela já aconteceu);
  vai para o log com `event: platform_event_write_failed`. A LEITURA é fail-closed: erro é erro
  nomeado, nunca lista vazia.
- Sem conteúdo sensível: `detail` é texto curto (<= 300), sem manifest, sem token, sem segredo.
- Tabela única (pk, sk), TTL `expiresAt` (90 dias). Itens:
    pk=event                       sk=<ms16>#<id>   o evento (lista geral, mais recente primeiro)
    pk=object#<kind>/<ns>/<name>   sk=<ms16>#<id>   cópia por objeto (trilha do detalhe)
    pk=user#<alias>                sk=notifications readAt (marca d'água)
    pk=user#<alias>                sk=read#<id>     lido por evento
"""
from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any, Iterable

EVENT_PK = "event"
TTL_SECONDS = 90 * 24 * 3600
DETAIL_MAX = 300
LIST_MAX = 200

ACTIONS = frozenset({
    "provision.requested", "provision.mr-opened", "provision.merged", "provision.failed", "provision.closed",
    "plan.submitted", "plan.retried", "plan.compensated", "plan.failed",
    "workload.restarted", "workload.scaled", "pod.deleted",
    "layout.reset",
    # Transições de Ready das instâncias, produzidas pela varredura agendada (platformReadySweep).
    "instance.ready", "instance.not-ready",
    # Promoção entre ambientes (environments-promotion): pedido de infra com origem em outro ambiente.
    "promotion.requested",
})
# Estado da varredura de Ready: um item por objeto, fora da trilha de eventos (não é evento).
READY_STATE_PK = "state#ready"
READY_SWEEP_ACTOR = "platform"
RESULTS = frozenset({"ok", "failed", "denied"})
_SAFE = re.compile(r"[^\w./:@=, -]+")
# Link interno do portal: além do texto, aceita a sintaxe de URL (#, ?, =, &, %).
_SAFE_LINK = re.compile(r"[^\w./:#?=&%-]+")
_ALIAS = re.compile(r"^[a-z][a-z0-9-]{1,63}$")


class EventStoreError(Exception):
    """Leitura falhou: o chamador responde com erro nomeado, nunca com lista vazia."""


def _text(value: Any, limit: int) -> str:
    return _SAFE.sub(" ", str(value or ""))[:limit].strip()


def _s(value: str) -> dict[str, str]:
    return {"S": value}


def _n(value: int) -> dict[str, str]:
    return {"N": str(int(value))}


def event_record(*, actor: str, action: str, kind: str, name: str, namespace: str = "", project: str = "",
                 result: str = "ok", detail: str = "", link: str = "", source: str = "", now: int | None = None,
                 event_id: str | None = None) -> dict[str, Any]:
    """O evento normalizado (dict simples). Valida ação e resultado: produtor com ação fora do
    vocabulário é bug do produtor e tem que aparecer no teste dele, não virar lixo na trilha."""
    if action not in ACTIONS:
        raise ValueError(f"unknown event action {action!r}")
    if result not in RESULTS:
        raise ValueError(f"unknown event result {result!r}")
    at = int(round((now if now is not None else time.time()) * 1000))
    return {
        "id": event_id or uuid.uuid4().hex,
        # `at` em milissegundos ordena a chave; `time` em segundos é o que a UI mostra.
        "at": at,
        "time": at // 1000,
        "actor": _text(actor, 64),
        "action": action,
        "kind": _text(kind, 64),
        "name": _text(name, 253),
        "namespace": _text(namespace, 63),
        "project": _text(project, 63),
        "result": result,
        "detail": _text(detail, DETAIL_MAX),
        "link": _SAFE_LINK.sub("", str(link or ""))[:300].strip(),
        "source": _text(source, 40),
    }


def object_key(kind: str, namespace: str, name: str) -> str:
    return f"object#{_text(kind, 64)}/{_text(namespace, 63)}/{_text(name, 253)}"


def plan_ready_sweep(previous: dict[str, bool | None], current: dict[str, bool]) -> dict[str, list[str]]:
    """Decide o que a varredura de Ready emite e grava. Função pura, testável sem DynamoDB.

    `previous` é o último estado conhecido por objeto (True/False, ou None = "ausente" na última
    varredura); `current` é o que o cluster mostra agora. Regras:
      - objeto NUNCA visto antes (não está em `previous`): só semeia o estado, não emite evento.
        A primeira varredura de um cluster com 8 instâncias prontas não pode acordar 8 notificações.
      - False -> True: `instance.ready`; True -> False: `instance.not-ready`; igual: nada.
      - sumiu (estava em `previous`, não está em `current`): grava None, não emite (remoção já é
        rastreada pelo fluxo de provisioning/GitOps, não é transição de Ready).
      - reapareceu (previous None): tratado como novo, só semeia.
    """
    ready: list[str] = []
    not_ready: list[str] = []
    seed: list[str] = []
    absent: list[str] = []
    for key, is_ready in current.items():
        if key not in previous or previous[key] is None:
            seed.append(key)
        elif previous[key] is False and is_ready:
            ready.append(key)
        elif previous[key] is True and not is_ready:
            not_ready.append(key)
    for key, was in previous.items():
        if key not in current and was is not None:
            absent.append(key)
    return {"ready": sorted(ready), "notReady": sorted(not_ready), "seed": sorted(seed), "absent": sorted(absent)}


class EventStore:
    """Store sobre o client boto3 do DynamoDB (API de baixo nível, como o resto da platform-api)."""

    def __init__(self, client: Any, table: str) -> None:
        self._client = client
        self._table = table

    @property
    def enabled(self) -> bool:
        return bool(self._table)

    # ----------------------------------------------------------------- escrita (fail-open)

    def record(self, **fields: Any) -> dict[str, Any] | None:
        """Grava o evento (geral + por objeto). Devolve o evento, ou None se o store está desligado.
        Falha de gravação vai para o log e NÃO propaga: a ação já aconteceu."""
        event = event_record(**fields)
        if not self.enabled:
            return None
        sk = f"{event['at']:016d}#{event['id']}"
        item = {"pk": _s(EVENT_PK), "sk": _s(sk), **self._attrs(event), "expiresAt": _n(event["time"] + TTL_SECONDS)}
        copy = {**item, "pk": _s(object_key(event["kind"], event["namespace"], event["name"]))}
        try:
            self._client.put_item(TableName=self._table, Item=item)
            self._client.put_item(TableName=self._table, Item=copy)
        except Exception as error:  # noqa: BLE001 - fail-open por desenho, com log
            print(json.dumps({"event": "platform_event_write_failed", "action": event["action"],
                              "id": event["id"], "error": str(error)[:300]}))
        return event

    @staticmethod
    def _attrs(event: dict[str, Any]) -> dict[str, Any]:
        attrs: dict[str, Any] = {"id": _s(event["id"]), "time": _n(event["time"]), "at": _n(event["at"]), "action": _s(event["action"]),
                                 "result": _s(event["result"])}
        for key in ("actor", "kind", "name", "namespace", "project", "detail", "link", "source"):
            if event[key]:
                attrs[key] = _s(event[key])
        return attrs

    # ----------------------------------------------------------------- leitura (fail-closed)

    def _query(self, pk: str, limit: int, *, since: int | None = None) -> list[dict[str, Any]]:
        kwargs: dict[str, Any] = {
            "TableName": self._table, "ScanIndexForward": False, "Limit": max(1, min(int(limit), LIST_MAX)),
            "KeyConditionExpression": "pk = :pk", "ExpressionAttributeValues": {":pk": _s(pk)},
        }
        if since is not None:
            kwargs["KeyConditionExpression"] = "pk = :pk AND sk > :since"
            kwargs["ExpressionAttributeValues"][":since"] = _s(f"{int(since) * 1000:016d}#")
        try:
            page = self._client.query(**kwargs)
        except Exception as error:  # noqa: BLE001
            raise EventStoreError(f"events unreadable: {str(error)[:200]}") from error
        return [self._parse(item) for item in page.get("Items", []) or []]

    @staticmethod
    def _parse(item: dict[str, Any]) -> dict[str, Any]:
        def text(key: str) -> str:
            return str((item.get(key) or {}).get("S") or "")
        return {"id": text("id"), "time": int((item.get("time") or {}).get("N") or 0), "actor": text("actor"),
                "action": text("action"), "kind": text("kind"), "name": text("name"), "namespace": text("namespace"),
                "project": text("project"), "result": text("result") or "ok", "detail": text("detail"),
                "link": text("link"), "source": text("source")}

    def list_events(self, *, limit: int = 100, actor: str = "", action: str = "", result: str = "",
                    projects: Iterable[str] | None = None) -> list[dict[str, Any]]:
        """Lista geral, mais recente primeiro. `projects` restringe (não-admin): só eventos de
        projetos visíveis OU cujo ator é o próprio (quem chama passa o alias em `actor`)."""
        if not self.enabled:
            raise EventStoreError("events store disabled")
        rows = self._query(EVENT_PK, LIST_MAX)
        allowed = None if projects is None else set(projects)
        out = []
        for row in rows:
            if allowed is not None and row["project"] not in allowed and row["actor"] != actor:
                continue
            if actor and allowed is None and row["actor"] != actor:
                continue
            if action and row["action"] != action:
                continue
            if result and row["result"] != result:
                continue
            out.append(row)
            if len(out) >= limit:
                break
        return out

    def object_trail(self, kind: str, namespace: str, name: str, *, limit: int = 50) -> list[dict[str, Any]]:
        if not self.enabled:
            raise EventStoreError("events store disabled")
        return self._query(object_key(kind, namespace, name), limit)

    # ----------------------------------------------------------------- notificações

    def read_state(self, alias: str) -> tuple[int, set[str]]:
        """(readAt, ids lidos) do usuário."""
        if not _ALIAS.match(alias):
            raise ValueError("invalid alias")
        try:
            page = self._client.query(TableName=self._table, KeyConditionExpression="pk = :pk",
                                      ExpressionAttributeValues={":pk": _s(f"user#{alias}")}, Limit=LIST_MAX)
        except Exception as error:  # noqa: BLE001
            raise EventStoreError(f"read state unreadable: {str(error)[:200]}") from error
        read_at, ids = 0, set()
        for item in page.get("Items", []) or []:
            sk = str((item.get("sk") or {}).get("S") or "")
            if sk == "notifications":
                read_at = int((item.get("readAt") or {}).get("N") or 0)
            elif sk.startswith("read#"):
                ids.add(sk[5:])
        return read_at, ids

    def notifications(self, alias: str, projects: Iterable[str], *, limit: int = 50) -> dict[str, Any]:
        """Eventos relevantes ao usuário com lido/não lido. Relevante = ator é ele OU projeto visível."""
        if not self.enabled:
            raise EventStoreError("events store disabled")
        allowed = set(projects)
        read_at, read_ids = self.read_state(alias)
        items = []
        for row in self._query(EVENT_PK, LIST_MAX):
            if row["actor"] != alias and row["project"] not in allowed:
                continue
            items.append({**row, "read": row["time"] <= read_at or row["id"] in read_ids})
            if len(items) >= limit:
                break
        return {"items": items, "unread": sum(1 for row in items if not row["read"]), "readAt": read_at}

    def mark_read(self, alias: str, *, until: int | None = None, event_id: str = "") -> None:
        """Marca tudo até `until` (marca d'água) e/ou um evento. Escrita pequena, fail-closed."""
        if not _ALIAS.match(alias):
            raise ValueError("invalid alias")
        if until is None and not event_id:
            raise ValueError("until or eventId is required")
        now = int(time.time())
        try:
            if until is not None:
                self._client.put_item(TableName=self._table, Item={
                    "pk": _s(f"user#{alias}"), "sk": _s("notifications"), "readAt": _n(min(int(until), now)),
                    "expiresAt": _n(now + TTL_SECONDS)})
            if event_id:
                if not re.fullmatch(r"[0-9a-f]{32}", event_id):
                    raise ValueError("invalid eventId")
                self._client.put_item(TableName=self._table, Item={
                    "pk": _s(f"user#{alias}"), "sk": _s(f"read#{event_id}"), "expiresAt": _n(now + TTL_SECONDS)})
        except ValueError:
            raise
        except Exception as error:  # noqa: BLE001
            raise EventStoreError(f"mark read failed: {str(error)[:200]}") from error

    # ----------------------------------------------------------------- varredura de Ready (fail-closed)

    def ready_states(self) -> dict[str, bool | None]:
        """Último estado de Ready por objeto (`kind/ns/name` -> True/False/None). Vazio na primeira
        varredura. Falha de leitura é erro nomeado: sem o estado anterior a varredura não pode
        decidir transição e não emite nada, em vez de inventar 'tudo ficou Ready agora'."""
        if not self.enabled:
            raise EventStoreError("events store disabled")
        states: dict[str, bool | None] = {}
        kwargs: dict[str, Any] = {"TableName": self._table, "KeyConditionExpression": "pk = :pk",
                                  "ExpressionAttributeValues": {":pk": _s(READY_STATE_PK)}}
        try:
            while True:
                page = self._client.query(**kwargs)
                for item in page.get("Items", []) or []:
                    key = str((item.get("sk") or {}).get("S") or "")
                    raw = item.get("ready") or {}
                    states[key] = None if raw.get("NULL") else bool(raw.get("BOOL"))
                if not page.get("LastEvaluatedKey"):
                    return states
                kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        except Exception as error:  # noqa: BLE001
            raise EventStoreError(f"ready state unreadable: {str(error)[:200]}") from error

    def write_ready_state(self, key: str, ready: bool | None, *, now: int | None = None) -> None:
        """Grava o estado de um objeto. Fail-closed: se não gravou, a próxima varredura reemitiria o
        mesmo evento, então o erro sobe e a varredura reporta a falha."""
        if not self.enabled:
            raise EventStoreError("events store disabled")
        at = int(now if now is not None else time.time())
        value: dict[str, Any] = {"NULL": True} if ready is None else {"BOOL": bool(ready)}
        try:
            self._client.put_item(TableName=self._table, Item={
                "pk": _s(READY_STATE_PK), "sk": _s(_text(key, 400)), "ready": value, "seenAt": _n(at),
                "expiresAt": _n(at + TTL_SECONDS)})
        except Exception as error:  # noqa: BLE001
            raise EventStoreError(f"ready state write failed: {str(error)[:200]}") from error
