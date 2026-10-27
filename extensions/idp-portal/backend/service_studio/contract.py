"""ServiceDraft v1: the single semantic source of a capability package.

A Service Owner (or a model on their behalf) proposes ONE object, the ServiceDraft. Every file
of the package is derived from it by `compiler.py`, so the form the wizard renders, the
schema the CI validates and the docs a consumer reads cannot disagree.

Everything here is a constant on purpose: the closed set of keys, the domains a Service Owner
may publish into, the values the platform imposes. A model cannot widen any of them, because
the validator compares against these tuples and never against something read from the draft.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

SCHEMA_VERSION = "service-draft/v1"
COMPILER = "service-studio/v1"
MAX_DRAFT_BYTES = 32 * 1024
MAX_FIELDS = 30
MAX_REQUIRES = 5

# Fixed by the platform, never by the draft (ADR-0006, ADR-0007, platform/catalog/README.md).
TARGET_ACCOUNTS = ("111122223333",)
DELETION_POLICY = "retain"
ARGO_APPLICATION = "agent-platform-instances"
READY_CONDITION = "ACK.ResourceSynced"
KRO_API_VERSION = "kro.run/v1alpha1"

# `agent/` is the Agent Builder's domain (ADR-0008): the Studio never publishes there.
DOMAINS = ("app", "cache", "compute", "database", "entrypoint", "frontend", "messaging", "storage")
# hybrid/crossplane need an ackGap justification (ADR-0005); that is a platform-team decision.
ENGINES = ("ack", "kro")
# `available` is a promotion done by the platform team after the RGD is proven live.
LIFECYCLES = ("planned", "preview")
FIELD_TYPES = ("string", "integer", "boolean", "stringMap", "stringList")

OP_CREATE, OP_EVOLVE, OP_DEPRECATE, OP_RETIRE = "create", "evolve", "deprecate", "retire"
OPS = (OP_CREATE, OP_EVOLVE, OP_DEPRECATE, OP_RETIRE)
DRAFT_OPS = (OP_CREATE, OP_EVOLVE)

ROOT_FIELDS = (
    "schemaVersion", "domain", "name", "version", "displayName", "displayNamePt", "description",
    "descriptionPt", "owner", "engine", "pattern", "lifecycle", "goldenPath", "rgdRef", "requires",
    "fields", "docs",
)
REQUIRED_ROOT = ("schemaVersion", "domain", "name", "version", "displayName", "description", "owner",
                 "engine", "pattern", "lifecycle", "goldenPath", "fields")
FIELD_KEYS = ("name", "type", "title", "description", "required", "default", "enum", "pattern",
              "minimum", "maximum", "example")
DOCS_KEYS = ("overview", "usage")

NAME_PATTERN = r"[a-z][a-z0-9-]{0,38}[a-z0-9]"
VERSION_PATTERN = r"v[1-9][0-9]?"
OWNER_PATTERN = r"[a-z][a-z0-9-]{1,62}[a-z0-9]"
GOLDEN_PATH_PATTERN = r"GP-[A-Z][0-9]{1,2}"
FIELD_NAME_PATTERN = r"[a-z][a-zA-Z0-9]{0,40}"
RGD_REF_PATTERN = r"platform/compositions/[a-z0-9][a-z0-9-]{0,60}-rgd\.yaml"
REQUIRES_PATTERN = r"[a-z][a-z0-9-]{0,30}/[a-z][a-z0-9-]{0,38}[a-z0-9]"
# Restricted regex alphabet for a field `pattern`: no lookarounds, no backreferences, bounded.
FIELD_REGEX_ALPHABET = r"[\^$\[\]()a-zA-Z0-9\-_.*+?{},|\\: /@]{1,120}"
SINGLE_LINE = r"\S(?:[^\u0000-\u001f\u007f]*\S)?"

# Copy of agent_builder.validator.SECRET_LIKE_PATTERN, so a bundle with only this package still
# works. tests/test_service_studio.py asserts the two are identical.
SECRET_LIKE_PATTERN = (
    r"(?:AKIA|ASIA)[0-9A-Z]{16}|-----BEGIN|"
    r"glpat-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[0-9A-Za-z-]{20,}|"
    r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|"
    r"(?:[Pp]assw(?:or)?d|PASSW(?:OR)?D|[Ss]ecret|SECRET|[Tt]oken|TOKEN|[Aa]pi[_-]?[Kk]ey|API[_-]?KEY)\s*[:=]\s*\S"
)
# Text that would be interpreted by something downstream: kro CEL (`${`), templating (`{{`),
# HTML in docs.md, script URLs, or markdown fences that break the generated docs.
MARKUP_PATTERN = r"\$\{|\{\{|<\s*/?\s*[a-zA-Z!]|javascript:|data:text|```"
# Instruction-override phrasing. The model's output is data, so this is defence in depth: a
# description that tries to steer a later reader (human or model) is refused, not rendered.
INSTRUCTION_PATTERN = (
    r"(?i)\b(?:ignore|disregard|override|bypass|forget)\b[^.\n]{0,40}\b(?:instructions?|rules?|polic(?:y|ies)|guardrails?|prompt)\b"
    r"|(?i:system\s+prompt|you\s+are\s+now|act\s+as\s+(?:an?\s+)?admin|kubectl\s+apply|git\s+push)"
)

# Field names are compared after lowercasing and dropping every non-alphanumeric character, so
# `db_Password`, `DB-PASSWORD` and `dbPassword` are the same name.
SECRET_NAME_TOKENS = ("password", "passwd", "secret", "token", "apikey", "credential", "accesskey",
                      "privatekey", "sshkey", "certificate", "kubeconfig")
IAM_NAME_TOKENS = ("rolearn", "iamrole", "policyarn", "policydocument", "assumerole", "permissionsboundary",
                   "principal", "iampolicy", "managedpolicy", "serviceaccount")
IAM_NAME_EXACT = ("role", "policy", "policies", "permissions", "actions")
NAMESPACE_NAME_TOKENS = ("namespace",)
PLATFORM_NAME_EXACT = ("deletionpolicy", "targetaccounts", "accountid", "account", "region", "awsregion")

MESSAGES: dict[str, tuple[str, str]] = {
    "schema_version": ("Unsupported draft schema version.", "Versão de schema do draft não suportada."),
    "too_large": ("Draft exceeds the size limit.", "O draft excede o limite de tamanho."),
    "required": ("Field is required.", "O campo é obrigatório."),
    "unknown_field": ("Field is not part of ServiceDraft v1.", "O campo não faz parte do ServiceDraft v1."),
    "type": ("Field has the wrong type.", "O campo tem o tipo errado."),
    "pattern": ("Value does not match the required format.", "O valor não casa com o formato exigido."),
    "enum": ("Value is not one of the allowed options.", "O valor não está entre as opções permitidas."),
    "too_long": ("Value is longer than the maximum.", "O valor é maior que o máximo."),
    "too_few": ("Fewer items than the minimum.", "Menos itens que o mínimo."),
    "too_many": ("More items than the maximum.", "Mais itens que o máximo."),
    "not_single_line": ("Value must be one trimmed line without control characters.", "O valor deve ser uma linha, sem espaço nas pontas e sem caractere de controle."),
    "secret_like": ("Value looks like a credential.", "O valor parece uma credencial."),
    "markup": ("Value carries markup or an expression that would be interpreted downstream.", "O valor traz markup ou expressão que seria interpretada adiante."),
    "instruction_like": ("Value reads like an instruction to override the platform policy.", "O valor parece uma instrução para burlar a policy da plataforma."),
    "duplicate": ("Value repeats an earlier entry.", "O valor repete uma entrada anterior."),
    "secret_field": ("Secrets are never form fields: the platform injects them by policy.", "Secret nunca é campo de formulário: a plataforma injeta por policy."),
    "iam_field": ("IAM is chosen by the platform policy, not by the form.", "IAM é escolhido pela policy da plataforma, não pelo formulário."),
    "namespace_field": ("The namespace is assigned by the platform policy.", "O namespace é atribuído pela policy da plataforma."),
    "platform_field": ("This value is imposed by the platform.", "Este valor é imposto pela plataforma."),
    "invalid_regex": ("The field pattern is not an accepted regular expression.", "O pattern do campo não é uma expressão regular aceita."),
    "invalid_default": ("The default does not satisfy the field's own constraints.", "O default não satisfaz as restrições do próprio campo."),
    "invalid_bounds": ("minimum is greater than maximum.", "minimum é maior que maximum."),
    "constraint_type": ("Constraint does not apply to this field type.", "A restrição não se aplica a este tipo de campo."),
    "rgd_unknown": ("The referenced composition is not in the repository.", "A composition referenciada não existe no repositório."),
    "field_not_in_rgd": ("The composition does not accept this field.", "A composition não aceita este campo."),
    "rgd_type_mismatch": ("Field type differs from the composition.", "O tipo do campo difere da composition."),
    "rgd_required_missing": ("The composition requires this field.", "A composition exige este campo."),
    "lifecycle_needs_rgd": ("A preview capability needs a composition (rgdRef).", "Uma capability preview precisa de composition (rgdRef)."),
    "unauthorized": ("Caller is not a Service Owner of this team.", "Quem chama não é Service Owner deste time."),
    "admin_only": ("Only a platform admin can do this.", "Só um admin da plataforma pode fazer isto."),
    "breaking_change": ("Breaking change in the same version: publish a new version instead.", "Breaking change na mesma versão: publique uma versão nova."),
}

WARNINGS: dict[str, tuple[str, str]] = {
    "default_differs": ("Default differs from the composition default.", "O default difere do default da composition."),
    "elevated_review": ("This change needs an elevated human review.", "Esta mudança exige review humano elevado."),
    "planned_without_rgd": ("Without a composition the capability is listed as planned.", "Sem composition a capability entra como planned."),
}


@dataclass(frozen=True)
class Issue:
    path: str
    code: str
    message: str = ""
    message_pt: str = ""

    @classmethod
    def of(cls, path: str, code: str, table: dict[str, tuple[str, str]] = MESSAGES) -> "Issue":
        en, pt = table.get(code, (code, code))
        return cls(path, code, en, pt)

    def as_dict(self) -> dict[str, str]:
        return {"path": self.path, "code": self.code, "message": self.message, "messagePt": self.message_pt}


@dataclass(frozen=True)
class Validation:
    errors: tuple[Issue, ...] = ()
    warnings: tuple[Issue, ...] = ()
    extras: dict[str, Any] = field(default_factory=dict)

    @property
    def valid(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict[str, Any]:
        return {"valid": self.valid, "errors": [e.as_dict() for e in self.errors],
                "warnings": [w.as_dict() for w in self.warnings]}


class StudioUnavailable(RuntimeError):
    """A dependency the validator needs (the composition files) is missing. Fail closed."""


def compiled(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)
