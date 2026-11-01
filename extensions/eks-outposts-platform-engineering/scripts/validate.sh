#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
README=${ROOT_README:-"$ROOT/../../README.md"}
[[ -f "$README" ]] || { echo "root README not found: $README" >&2; exit 2; }
MODE=${1:-}
export PYTHONDONTWRITEBYTECODE=1
python3 - "$ROOT" "$README" <<'PY'
import os, re, sys
from pathlib import Path
root, readme = Path(sys.argv[1]), Path(sys.argv[2])
files=[p for p in root.rglob('*') if p.is_file() and '.runtime' not in p.parts]
if readme.is_file(): files.append(readme)
deny_file=os.environ.get('PRIVATE_DENYLIST_FILE')
deny_rules=[]
if deny_file:
  for line in Path(deny_file).read_text().splitlines():
    value=line.strip()
    if not value or value.startswith('#'): continue
    mode,term=value.split(':',1); mode=mode.strip(); term=term.strip()
    if mode not in {'word','substring'} or not term: raise SystemExit(f'invalid private denylist rule on line {len(deny_rules)+1}')
    deny_rules.append((mode,term.lower()))
  if not deny_rules: raise SystemExit('private denylist is empty')
markers=['TO'+'DO','FIX'+'ME','T'+'BD','CHANGE'+'ME','UN'+'RESOLVED']
foreign_terms=[''.join(x) for x in [('u','ma linha'),('me','dido'),('ja','nela'),('a','chado'),('des','ligado'),('por pa','drao'),('n','ao'),('so','mente'),('cr','ia'),('rec','urso'),('co','nta'),('reg','iao'),('serv','ico'),('aplic','acao'),('va','zio'),('ex','ige')]]
patterns={
  'account-id': re.compile(r'(?<![0-9a-f])[0-9]{12}(?![0-9a-f])', re.I),
  'real-resource-id': re.compile(r'\b(?:i|vpc|subnet|sg|op|scr)-[0-9a-f]{8,17}\b', re.I),
  'architecture-version-name': re.compile(r'(?:EKS|local cluster|outposts)[^\n]{0,40}\bv[12]\b|(?:cluster|outposts)-v[12]\b', re.I),
  'forbidden-term': re.compile(r'\b'+'allow'+'list'+r'\b', re.I),
  'credential': re.compile(r'(?:A'+'KIA|A'+'SIA)[A-Z0-9]{16}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|aws_'+'secret_access_key'+r'\s*[=:]\s*[^<$\s]', re.I),
  'template-marker': re.compile(r'\b(?:'+'|'.join(markers)+r')\b|__[A-Z0-9_]+__|@[a-z][a-z0-9-]*@'),
  'language-term': re.compile(r'\b(?:'+'|'.join(re.escape(x) for x in foreign_terms)+r')\b', re.I),
  'em-dash': re.compile(chr(0x2014)),
}
# Inside the extension: no accented Latin letter (the docs are en-US) and no claim of a live acceptance run.
local_patterns={
  'non-english-letter': re.compile('['+chr(0xC0)+'-'+chr(0xD6)+chr(0xD8)+'-'+chr(0xF6)+chr(0xF8)+'-'+chr(0x24F)+chr(0x1E00)+'-'+chr(0x1EFF)+']'),
}
# A sentence that says a run succeeded on real infrastructure is an acceptance claim unless it is negated, conditional
# or attributed to the source implementation. The verbs are assembled so this file does not match itself.
claim_verbs='|'.join(['valid'+'ated','veri'+'fied','tes'+'ted','pro'+'ven','exer'+'cised','con'+'firmed','demon'+'strated','mea'+'sured','succ'+'eeded','pas'+'sed','wor'+'ked'])
claim_env=r'(?:clusters?|racks?|Outposts?|hardware|production)'
claim_rx=re.compile(r'\b(?:'+claim_verbs+r')\b[^.;\n]{0,80}?\b'+claim_env+r'\b|\b'+claim_env+r'\b[^.;\n]{0,40}?\b(?:was|were|has been|have been)\s+(?:successfully\s+)?(?:'+claim_verbs+r')\b', re.I)
claim_exempt=re.compile(r"\b(?:not|never|no|until|unless|must|should|cannot|without|source)\b", re.I)
# Portuguese prose without accents: two distinct Portuguese function words, written in lower case or capitalized,
# on one line. Upper-case acronyms (NAS, DOS) and hyphenated or dotted tokens do not count.
pt_words={''.join(x) for x in [('d','a'),('d','as'),('d','os'),('s','em'),('p','ara'),('p','elo'),('p','ela'),('u','ma'),('q','ue'),('a','os'),('n','as'),('n','os'),('dur','ante'),('ai','nda'),('por','que'),('on','de'),('is','so'),('es','sa'),('es','se'),('dep','ois'),('qua','ndo'),('ent','re'),('so','bre'),('ma','is'),('t','em'),('s','ao'),('est','ao'),('c','om'),('n','um'),('nu','ma'),('pe','los'),('pe','las'),('tam','bem'),('ent','ao'),('ag','ora'),('ess','es'),('est','e'),('est','a'),('voc','e'),('n','ao'),('m','as'),('n','ossa'),('n','osso')]}
pt_token=re.compile(r'(?<![\w./@:-])([A-Z]?[a-z]+)(?![\w/@-])')
def acceptance_claims(text):
  return [(n,s.strip()) for n,line in enumerate(text.splitlines(),1) for s in re.split(r'(?<=[.;])\s+',line) if claim_rx.search(s) and not claim_exempt.search(s)]
def portuguese_lines(text):
  return [(n,line.strip()) for n,line in enumerate(text.splitlines(),1) if len({w.lower() for w in pt_token.findall(line)} & pt_words)>=2]
def slug(heading):
  text=re.sub(r'[`*_]|\[([^]]*)\]\([^)]*\)', lambda m: m.group(1) or '', heading.strip().lower())
  return re.sub(r'\s', '-', re.sub(r'[^\w\s-]', '', text))
def anchors(path):
  found, seen, fenced = set(), {}, False
  for line in path.read_text('utf-8').splitlines():
    if line.lstrip().startswith('```'): fenced = not fenced; continue
    if fenced: continue
    m=re.match(r'#{1,6}\s+(.*?)\s*#*\s*$', line)
    if m:
      base=slug(m.group(1)); n=seen.get(base,0); seen[base]=n+1
      found.add(base if n==0 else f'{base}-{n}')
    found.update(re.findall(r'<a\s+(?:id|name)="([^"]+)"', line))
  return found
def denied(text):
  lower=text.lower(); found=[]
  for mode,term in deny_rules:
    if mode=='substring' and term in lower: found.append(term)
    elif mode=='word' and re.search(r'(?<![A-Za-z0-9_])'+re.escape(term)+r'(?![A-Za-z0-9_])',lower): found.append(term)
  return found
errors=[]
for path in files:
  rel=path.relative_to(root) if path.is_relative_to(root) else Path(path.name)
  rel_text=str(rel)
  for name in ('account-id','real-resource-id','architecture-version-name','forbidden-term','em-dash'):
    match=patterns[name].search(rel_text)
    if match: errors.append(f'{rel}:path:{name}:{match.group(0)}')
  for term in denied(rel_text): errors.append(f'{rel}:path:private-denylist-match')
  try: text=path.read_text('utf-8')
  except UnicodeDecodeError: continue
  scan_text=text
  if str(rel)=='platform/components/node-local-dns/node-local-dns.yaml':
    token='_'*2+'PILLAR'+'_'*2+'CLUSTER'+'_'*2+'DNS'+'_'*2
    scan_text=scan_text.replace(token,'NODELOCAL_RUNTIME_DNS')
  for name,rx in patterns.items():
    for m in rx.finditer(scan_text): errors.append(f'{rel}:{scan_text.count(chr(10),0,m.start())+1}:{name}:{m.group(0)}')
  for term in denied(scan_text): errors.append(f'{rel}:private-denylist-match')
  inside=path.resolve().is_relative_to(root.resolve())
  if inside:
    for name,rx in local_patterns.items():
      for m in rx.finditer(scan_text): errors.append(f'{rel}:{scan_text.count(chr(10),0,m.start())+1}:{name}:{m.group(0)}')
    for n,sentence in acceptance_claims(scan_text): errors.append(f'{rel}:{n}:acceptance-claim:{sentence[:120]}')
    for n,line in portuguese_lines(scan_text): errors.append(f'{rel}:{n}:non-english-prose:{line[:120]}')
  for m in re.finditer(r'\[[^]]+\]\((?!https?://|#)([^)]+)\)', text):
    target=m.group(1).split('#',1)[0]
    if target and not (path.parent/target).resolve().exists(): errors.append(f'{rel}:{text.count(chr(10),0,m.start())+1}:broken-link:{target}')
  if path.suffix=='.md' and inside:
    for m in re.finditer(r'\[[^]]+\]\((?!https?://)([^)#]*)#([^)]+)\)', text):
      target=(path.parent/m.group(1)).resolve() if m.group(1) else path
      if target.suffix=='.md' and target.is_file() and m.group(2) not in anchors(target):
        errors.append(f'{rel}:{text.count(chr(10),0,m.start())+1}:broken-anchor:{m.group(1)}#{m.group(2)}')
if errors:
  print('\n'.join(errors)); raise SystemExit(1)
unsafe='A'+'KIA'+'ABCDEFGHIJKLMNOP vpc-'+'0123456789abcdef0 ' + chr(0x2014) + ' TO'+'DO'
safe='platform-outposts <AWS_ACCOUNT_ID> https://docs.aws.amazon.com/eks/ platform.local'
assert any(rx.search(unsafe) for rx in patterns.values())
assert not any(rx.search(safe) for rx in patterns.values())
assert local_patterns['non-english-letter'].search('Regi'+chr(0xE3)+'o')
for sample in ['valid'+'ated end to end on two clusters', 'The live behavior was exer'+'cised successfully on two Outposts racks;', 'Both clusters have been valid'+'ated.']:
  assert acceptance_claims(sample), sample
for sample in ['Region valid'+'ated until every criterion passes on the target rack', 'The live behavior has not been mea'+'sured;', 'the source exer'+'cised that class on the same rack.']:
  assert not acceptance_claims(sample), sample
for sample in ['O carrinho continua funcionando dur'+'ante o corte d'+'a rede, s'+'em depender d'+'a nuvem.', 'A loja funciona s'+'em a rede, m'+'as o painel mostra a queda.']:
  assert portuguese_lines(sample), sample
for sample in ['Use the data from the sem-ver tag.', 'Set NAS mount options; DOS line endings fail.']:
  assert not portuguese_lines(sample), sample
assert slug('Rollback and `uninstall`') == 'rollback-and-uninstall' and slug('The 8-minute scene') == 'the-8-minute-scene'
if deny_rules:
  assert denied(deny_rules[0][1])
  assert not denied('public-canary-value')
print(f'PASS public scan files={len(files)} positive-control=detected negative-control=clean')
PY
python3 "$ROOT/scripts/check-script-invocations.py" "$ROOT" "$README"
python3 - "$ROOT/platform/gitops/render-secret.py" "$ROOT/platform/gitops/render-runtime.py" "$ROOT/scripts/emit-contract.py" <<'PY'
import sys
from pathlib import Path
for name in sys.argv[1:]: compile(Path(name).read_text(), name, 'exec')
PY
python3 "$ROOT/scripts/check-iac-parity.py" "$ROOT"
python3 "$ROOT/scripts/check-reachability.py" "$ROOT"
python3 "$ROOT/platform/components/crossplane/tests/test-serverless.py"
python3 "$ROOT/platform/components/crossplane/serverless-handler/build.py" --check
python3 -m unittest discover -s "$ROOT/platform/components/chaos-egress/tests"
python3 "$ROOT/platform/components/observability/connectivity/tests/test_connectivity.py"
python3 "$ROOT/platform/components/observability/connectivity/tests/test_queries_doc.py"
python3 "$ROOT/platform/apps/retail-store/tests/test_retail_store.py"
python3 - "$ROOT" <<'PY'
import json, shutil, subprocess, sys, tempfile
from pathlib import Path
root=Path(sys.argv[1])
contract={"cluster_name":"platform-outposts","aws_region":"us-west-2","account_id":"1"*12,"outpost_arn":"arn:aws:outposts:us-west-2:"+"1"*12+":outpost/op-"+"a"*17,"kubernetes_version":"1.35","registry_service_ip":"172.20.0.20","node_subnet_cidr":"10.40.1.0/24","bastion_subnet_cidr":"10.40.0.0/24","kubernetes_service_ip_cidr":"172.20.0.1/32","cluster_dns_service_ip":"172.20.0.10","ebs_csi_controller_credential_cidr":"169.254.169.254/32"}
with tempfile.TemporaryDirectory() as tmp:
  target=Path(tmp); (target/"components").mkdir(); (target/"apps").mkdir()
  shutil.copytree(root/"platform/components/network-policies",target/"components/network-policies")
  shutil.copytree(root/"platform/components/crossplane",target/"components/crossplane")
  shutil.copytree(root/"platform/components/node-local-dns",target/"components/node-local-dns")
  shutil.copytree(root/"platform/apps/network-policy-demo",target/"apps/network-policy-demo")
  source=target/"contract.json"; source.write_text(json.dumps(contract))
  subprocess.run([sys.executable,str(root/"platform/gitops/render-runtime.py"),str(source),str(target)],check=True)
  rendered=subprocess.check_output([sys.executable,str(root/"platform/gitops/render-secret.py"),str(source),str(root/"platform/gitops/contract-secret.template.yaml")],text=True)
  assert "${" not in rendered
  for path in list((target/"components/network-policies").glob("*.yaml"))+list((target/"apps/network-policy-demo").glob("*.yaml"))+[target/"components/crossplane/ca/networkpolicies.yaml",target/"components/node-local-dns/node-local-dns.yaml"]:
    assert not any(token in path.read_text() for token in ("${OUTPOST_SUBNET_CIDR}","${BASTION_SUBNET_CIDR}","${KUBERNETES_SERVICE_IP_CIDR}","${CLUSTER_DNS_SERVICE_IP}","${EBS_CSI_CONTROLLER_CREDENTIAL_CIDR}"))
print('PASS normalized-contract-render')
PY
python3 - "$ROOT" <<'PY'
import sys, yaml
from pathlib import Path
class Loader(yaml.SafeLoader): pass
def tagged(loader, suffix, node):
  if isinstance(node, yaml.ScalarNode): return loader.construct_scalar(node)
  if isinstance(node, yaml.SequenceNode): return loader.construct_sequence(node)
  return loader.construct_mapping(node)
Loader.add_multi_constructor('!', tagged)
for path in Path(sys.argv[1]).rglob('*'):
  if path.suffix in {'.yaml','.yml'} and '.runtime' not in path.parts:
    list(yaml.load_all(path.read_text(), Loader=Loader))
print('PASS yaml-parse')
PY
for script in "$ROOT"/scripts/*.sh "$ROOT"/infrastructure/cloudformation/*.sh "$ROOT"/platform/gitops/*.sh "$ROOT"/platform/components/registry/*.sh "$ROOT"/platform/components/chaos-egress/*.sh; do bash -n "$script"; done
if command -v shellcheck >/dev/null; then shellcheck "$ROOT"/scripts/*.sh "$ROOT"/infrastructure/cloudformation/*.sh "$ROOT"/platform/gitops/*.sh "$ROOT"/platform/components/registry/*.sh "$ROOT"/platform/components/chaos-egress/*.sh; fi
if command -v kubeconform >/dev/null; then
  manifests=()
  while IFS= read -r -d '' candidate; do
    grep -q '^kind:' "$candidate" && manifests+=("$candidate")
  done < <(find "$ROOT/platform" -type f -name '*.yaml' -not -path '*/values/*' -not -path '*/.runtime/*' -print0)
  kubeconform -strict -summary -ignore-missing-schemas "${manifests[@]}"
fi
if command -v helm >/dev/null && [[ -d "$ROOT/platform/.runtime/charts" ]]; then
  python3 - "$ROOT" <<'PY'
import re, subprocess, sys, yaml
from pathlib import Path
root = Path(sys.argv[1]); charts = root / "platform" / ".runtime" / "charts"
releases = set()
for name, chart, namespace, values in re.findall(r'helm upgrade --install (\S+) "\$CHARTS/([^"]+)" -n (\S+)[^\n]*?-f "\$ROOT/([^"]+)"', (root / "platform/gitops/bootstrap.sh").read_text()):
  releases.add((name, charts / chart, namespace, root / values))
for element in re.findall(r"\{app: ([^,]+), kind: helm, namespace: ([^,]+), [^}]*chart: charts/([^,]+), values: ([^}]+)\}", (root / "platform/gitops/applicationset.yaml").read_text()):
  releases.add((element[0], charts / element[2].strip(), element[1], root / "platform" / element[3].strip()))
claims, bad = 0, []
for name, chart, namespace, values in sorted(releases, key=str):
  rendered = subprocess.run(["helm", "template", name, str(chart), "-n", namespace, "-f", str(values)], check=True, capture_output=True, text=True).stdout
  for document in yaml.safe_load_all(rendered):
    if not document: continue
    kind, spec = document.get("kind"), document.get("spec") or {}
    found = []
    if kind == "PersistentVolumeClaim": found = [spec.get("storageClassName")]
    elif kind == "StatefulSet": found = [t["spec"].get("storageClassName") for t in spec.get("volumeClaimTemplates") or []]
    elif kind == "VMSingle" and spec.get("storage"): found = [spec["storage"].get("storageClassName")]
    elif kind == "VMAlertmanager" and spec.get("storage"): found = [spec["storage"].get("volumeClaimTemplate", {}).get("spec", {}).get("storageClassName")]
    for value in found:
      claims += 1
      if value != "platform-ebs-gp2": bad.append(f"{values.name}:{kind}/{document['metadata']['name']}={value}")
assert len(releases) >= 7, f"expected at least 7 Helm releases, found {len(releases)}"
assert claims > 0, "no rendered claims"
assert not bad, "rendered claims outside platform-ebs-gp2: " + ", ".join(bad)
print(f"PASS rendered-claims releases={len(releases)} claims={claims} class=platform-ebs-gp2")
PY
else
  echo "SKIP rendered-claims: run bash scripts/fetch-charts.sh to render the pinned charts"
fi
if command -v terraform >/dev/null; then
  terraform -chdir="$ROOT/infrastructure/terraform" fmt -check -recursive
  mkdir -p "$ROOT/platform/.runtime"
  tf_test=$(mktemp -d "$ROOT/platform/.runtime/terraform-validate.XXXXXX")
  cp -R "$ROOT/infrastructure/terraform/." "$tf_test/"
  terraform -chdir="$tf_test" init -backend=false -input=false >/dev/null
  terraform -chdir="$tf_test" validate
  rm -rf "$tf_test"
fi
if command -v cfn-lint >/dev/null; then cfn-lint "$ROOT"/infrastructure/cloudformation/*.yaml; fi
if [[ "$MODE" == "--runtime" ]]; then
  kubectl wait --for=condition=Ready nodes --all --timeout=10m
  [[ "$(kubectl get storageclass platform-ebs-gp2 -o jsonpath='{.provisioner}/{.parameters.type}')" == ebs.csi.aws.com/gp2 ]] || { echo "platform-ebs-gp2 is not an EBS CSI gp2 class" >&2; exit 1; }
  # Force a fresh credential fetch under the enforced NetworkPolicy before the smoke volume, then prove the
  # controller reaches the instance profile endpoint and not the Pod Identity agent endpoint.
  kubectl -n kube-system rollout restart deployment/ebs-csi-controller
  kubectl -n kube-system rollout status deployment/ebs-csi-controller --timeout=10m
  kubectl apply -f "$ROOT/platform/components/storage/smoke-test.yaml"
  cleanup_runtime_fixture(){ kubectl delete namespace ebs-csi-test --ignore-not-found --wait=false >/dev/null; }
  trap cleanup_runtime_fixture EXIT
  kubectl -n ebs-csi-test wait --for=condition=Ready pod/ebs-gp2-smoke --timeout=10m
  controller_pod=$(kubectl -n kube-system get pod -l app=ebs-csi-controller -o jsonpath='{.items[0].metadata.name}')
  credential_probe=$(kubectl -n kube-system debug "pod/$controller_pod" --image=harbor.local/library/busybox:1.37.0 --attach=true --quiet --container=credential-probe -- sh -c 'nc -z -w 5 169.254.169.254 80 && echo imds=open || echo imds=closed; nc -z -w 5 169.254.170.23 80 && echo agent=open || echo agent=closed')
  [[ "$credential_probe" == *imds=open* && "$credential_probe" == *agent=closed* ]] || { echo "EBS CSI controller credential path differs: $credential_probe" >&2; exit 1; }
  kubectl -n kube-system rollout restart deployment/ebs-csi-controller
  kubectl -n kube-system rollout status deployment/ebs-csi-controller --timeout=10m
  kubectl -n ebs-csi-test exec ebs-gp2-smoke -- test -s /data/sentinel
  smoke_pv=$(kubectl -n ebs-csi-test get pvc ebs-gp2 -o jsonpath='{.spec.volumeName}')
  [[ "$(kubectl get pv "$smoke_pv" -o jsonpath='{.spec.csi.driver}')" == ebs.csi.aws.com ]] || { echo "smoke volume was not provisioned by the EBS CSI driver" >&2; exit 1; }
  kubectl get pvc -A -o json | python3 -c 'import json,sys; d=json.load(sys.stdin); ns={"registry-local","git-local","monitoring","victorialogs"}; claims=[x for x in d["items"] if x["metadata"]["namespace"] in ns]; bad=[x["metadata"]["namespace"]+"/"+x["metadata"]["name"] for x in claims if x["spec"].get("storageClassName")!="platform-ebs-gp2" or x.get("status",{}).get("phase")!="Bound"]; assert claims, "no platform claims found"; assert not bad, "platform claims not bound to platform-ebs-gp2: "+str(bad)'
  kubectl -n registry-local rollout status deployment/harbor-core --timeout=10m
  kubectl -n git-local rollout status deployment/gitea --timeout=10m
  kubectl -n kube-system rollout status daemonset/node-local-dns --timeout=10m
  kubectl -n victorialogs rollout status deployment/victorialogs-server --timeout=10m
  expected_images=$(grep -cv '^[[:space:]]*$' "$ROOT/platform/components/registry/images.txt")
  mirrored_images=$(kubectl -n registry-local logs job/platform-image-mirror | grep -c '^MIRROR_OK ')
  [[ "$mirrored_images" == "$expected_images" ]] || { echo "mirror inventory mismatch: $mirrored_images/$expected_images" >&2; exit 1; }
  kubectl -n argocd get applications -o json | python3 -c 'import json,sys; d=json.load(sys.stdin); bad=[x["metadata"]["name"] for x in d["items"] if x.get("status",{}).get("sync",{}).get("status")!="Synced" or x.get("status",{}).get("health",{}).get("status")!="Healthy"]; assert not bad, "unhealthy applications: "+str(bad)'
  code=$(kubectl -n demo-netpol exec deployment/frontend -- curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://backend:8080/)
  [[ "$code" == 200 ]] || { echo "frontend to backend failed: $code" >&2; exit 1; }
  kubectl -n demo-netpol exec deployment/backend -- nc -w 5 db 5432 | grep -q db-ok
  if kubectl -n demo-netpol exec deployment/frontend -- nc -w 5 db 5432 >/dev/null 2>&1; then echo "frontend unexpectedly reached db" >&2; exit 1; fi
  echo "PASS runtime storage, local services, GitOps, and NetworkPolicy controls"
fi
