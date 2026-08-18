#!/usr/bin/env node
/**
 * apply-genai-patches.js
 *
 * Applies to the Backstage scaffold the 3 edits the official AWS GenAI plugin
 * documentation asks to be made by hand:
 *
 *   1. packages/backend/src/index.ts        -> registers the 2 backend plugins
 *   2. packages/app/src/App.tsx             -> /assistant/:agentName route
 *   3. packages/app/src/components/Root/Root.tsx -> "Chat Assistant" menu item
 *
 * It is IDEMPOTENT: running it N times produces the same result. That allows
 * incremental rebuilds and lets the participant run the script after touching
 * the files.
 *
 * Usage: node apply-genai-patches.js <backstage-root-path>
 * Reference: https://github.com/awslabs/backstage-plugins-for-aws/tree/main/plugins/genai
 */

const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.cwd();
let changed = 0;

function patch(relPath, label, fn) {
  const file = path.join(root, relPath);
  if (!fs.existsSync(file)) {
    console.error(`[patch] FAILED: file not found -> ${relPath}`);
    process.exit(1);
  }
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === null) {
    console.log(`[patch] already applied (no-op): ${label}`);
    return;
  }
  if (after === before) {
    console.error(`[patch] FAILED: anchor not found in ${relPath} (${label})`);
    process.exit(1);
  }
  fs.writeFileSync(file, after, 'utf8');
  changed++;
  console.log(`[patch] applied: ${label} (${relPath})`);
}

// ---------------------------------------------------------------------------
// 1. Backend: registers the GenAI plugin and the LangGraph agent type.
//    The backend.add() calls must come BEFORE backend.start().
// ---------------------------------------------------------------------------
patch('packages/backend/src/index.ts', 'GenAI backend plugins', src => {
  if (src.includes('@aws/genai-plugin-for-backstage-backend')) return null;
  const anchor = 'backend.start();';
  if (!src.includes(anchor)) return src;
  const lines = [
    "// AWS GenAI plugin: the base plugin exposes the /api/aws-genai API and the",
    "// langgraph module provides the agent implementation used by the agents in",
    "// app-config (genai.agents.<name>.langgraph).",
    "backend.add(import('@aws/genai-plugin-for-backstage-backend'));",
    "backend.add(import('@aws/genai-plugin-langgraph-agent-for-backstage'));",
  ];
  // The create-app scaffold ALREADY registers the kubernetes plugin in recent
  // versions. Registering it twice takes the whole backend down at boot:
  //   ExtensionPoint 'kubernetes.objects-provider' is already registered
  // (measured in event fb1c47c8). Only add it if the scaffold does not have it.
  if (!src.includes('plugin-kubernetes-backend')) {
    lines.push("// Kubernetes plugin backend: feeds the Kubernetes tab on the entity pages.");
    lines.push("backend.add(import('@backstage/plugin-kubernetes-backend'));");
  }
  lines.push('', anchor);
  const block = lines.join('\n');
  return src.replace(anchor, block);
});

// ---------------------------------------------------------------------------
// 1b. EntityPage.tsx: Kubernetes tab on the service page.
//     Tolerant ON PURPOSE: the tabs are an extra, and the patch() helper kills
//     the build with exit 1 when the anchor does not match. The Backstage
//     scaffold changes layout between versions, and it is not worth taking the
//     whole image down - and module 3 with it - over a tab. If it does not
//     match, warn and move on.
// ---------------------------------------------------------------------------
function patchEntityPageK8s() {
  const rel = 'packages/app/src/components/catalog/EntityPage.tsx';
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.warn(`[patch] WARNING: ${rel} not found - Kubernetes tab not added`);
    return;
  }
  const before = fs.readFileSync(file, 'utf8');
  // Guard PER TAB, not a single guard: the current Backstage scaffold already
  // ships the Kubernetes tab out of the box (measured in the 13/08 build), and
  // a single guard on EntityKubernetesContent made the whole patch a no-op -
  // taking away the Argo CD tab, which is exactly the one the scaffold does
  // NOT have.
  const hasK8s = before.includes('EntityKubernetesContent');
  const hasArgo = before.includes('EntityArgoCDHistoryCard');
  if (hasK8s && hasArgo) {
    console.log('[patch] already applied (no-op): Kubernetes and Argo CD tabs');
    return;
  }
  // Deterministic anchor: the first </EntityLayout> AFTER
  // 'const serviceEntityPage' closes the service entity page.
  const svc = before.indexOf('const serviceEntityPage');
  if (svc === -1) {
    console.warn('[patch] WARNING: serviceEntityPage not found - Kubernetes tab not added');
    return;
  }
  const close = before.indexOf('</EntityLayout>', svc);
  if (close === -1) {
    console.warn('[patch] WARNING: EntityLayout closing tag not found - Kubernetes tab not added');
    return;
  }
  const parts = [];
  if (!hasK8s) parts.push(
    '    <EntityLayout.Route path="/kubernetes" title="Kubernetes">',
    '      <EntityKubernetesContent refreshIntervalMs={30000} />',
    '    </EntityLayout.Route>');
  if (!hasArgo) parts.push(
    '    <EntityLayout.Route path="/argocd" title="Argo CD">',
    '      <EntityArgoCDHistoryCard />',
    '    </EntityLayout.Route>');
  const tab = parts.concat(['', '  ']).join('\n');
  let out = before.slice(0, close) + tab + before.slice(close);
  // imports go in ONLY now that the usages exist - an orphan import is a build
  // error under Backstage's strict tsconfig (noUnusedLocals).
  if (!hasK8s) out = "import { EntityKubernetesContent } from '@backstage/plugin-kubernetes';\n" + out;
  if (!hasArgo) out = "import { EntityArgoCDHistoryCard } from '@roadiehq/backstage-plugin-argo-cd';\n" + out;
  fs.writeFileSync(file, out, 'utf8');
  changed++;
  console.log(`[patch] applied: ${[!hasK8s && 'Kubernetes tab', !hasArgo && 'Argo CD tab'].filter(Boolean).join(' + ')} (${rel})`);
}
patchEntityPageK8s();

// ---------------------------------------------------------------------------
// 1c. examples/entities.yaml: the portal registers ITSELF in the catalog, with
//     the annotations the Kubernetes and Argo CD tabs consume. Without an
//     annotated entity the two tabs have nothing to show, and the most
//     didactic example there is, is the portal watching its own deployment.
// ---------------------------------------------------------------------------
patch('examples/entities.yaml', 'annotated backstage-portal entity', src => {
  if (src.includes('backstage-portal')) return null;
  return src.trimEnd() + `
---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: backstage-portal
  description: The developer portal you are looking at right now
  annotations:
    backstage.io/kubernetes-label-selector: app=backstage
    argocd/app-name: backstage-portal
spec:
  type: service
  lifecycle: production
  owner: guests
  system: examples
`;
});

// ---------------------------------------------------------------------------
// 2. App.tsx: AgentChatPage import + route inside <FlatRoutes>.
//    The :agentName in the URL matches the key in the app-config genai.agents.
// ---------------------------------------------------------------------------
patch('packages/app/src/App.tsx', '/assistant/:agentName route', src => {
  if (src.includes('@aws/genai-plugin-for-backstage')) return null;
  let out = src;

  const importAnchor = "import { apis } from './apis';";
  if (!out.includes(importAnchor)) return src;
  out = out.replace(
    importAnchor,
    "import { AgentChatPage } from '@aws/genai-plugin-for-backstage';\n" + importAnchor,
  );

  const routeAnchor = '  </FlatRoutes>';
  if (!out.includes(routeAnchor)) return src;
  out = out.replace(
    routeAnchor,
    '    <Route path="/assistant/:agentName" element={<AgentChatPage />} />\n' + routeAnchor,
  );

  return out;
});

// ---------------------------------------------------------------------------
// 3. Root.tsx: menu item pointing at the `general` agent.
// ---------------------------------------------------------------------------
patch('packages/app/src/components/Root/Root.tsx', 'Chat Assistant menu', src => {
  if (src.includes('to="assistant/general"')) return null;
  let out = src;

  // ChatIcon is exported by @backstage/core-components; the scaffold already
  // imports several symbols from that package, so just add to the existing list.
  if (!/\bChatIcon\b/.test(out)) {
    const anchor = '  SidebarDivider,';
    if (!out.includes(anchor)) return src;
    out = out.replace(anchor, '  ChatIcon,\n' + anchor);
  }

  const itemAnchor =
    '        <SidebarItem icon={CreateComponentIcon} to="create" text="Create..." />';
  if (!out.includes(itemAnchor)) return src;
  out = out.replace(
    itemAnchor,
    itemAnchor +
      '\n        <SidebarItem icon={ChatIcon} to="assistant/general" text="Chat Assistant" />',
  );

  return out;
});

console.log(`[patch] done - ${changed} file(s) modified.`);
