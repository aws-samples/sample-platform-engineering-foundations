#!/usr/bin/env node
/**
 * add-genai-resolutions.js
 *
 * Adds to the ROOT package.json of Backstage the `resolutions` required for the
 * AWS GenAI plugin to install consistently.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The @aws/genai-plugin-langgraph-agent-for-backstage@0.7.2 package pins EXACT
 * versions of the LangChain family:
 *
 *   "@langchain/core": "0.3.57"
 *   "@langchain/aws": "0.1.10"
 *   "@langchain/langgraph": "0.2.74"
 *
 * ... but leaves Ollama on an open range:
 *
 *   "@langchain/ollama": "^1.0.0"
 *
 * Every 1.x version of @langchain/ollama requires the peer
 * "@langchain/core": "^1.0.0", and the `@langchain/core/language_models/compat`
 * import it does only exists in core 1.x. With core locked at 0.3.57, the
 * backend breaks AT BOOT with:
 *
 *   ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './language_models/compat'
 *   is not defined by "exports" in @langchain/core/package.json
 *
 * @langchain/ollama@0.2.1 is the last version whose peer (>=0.2.21 <0.4.0) is
 * satisfied by core 0.3.57, so we lock it there. The workshop uses Amazon
 * Bedrock, so the Ollama code path never runs: the pin exists only so the module
 * LOADS without breaking the boot.
 *
 * This is an upstream packaging bug (the plugin is marked as experimental). Once
 * the plugin pins Ollama, this resolution can be removed.
 *
 * Usage: node add-genai-resolutions.js <path-to-backstage-root>
 */

const fs = require('fs');
const path = require('path');

const RESOLUTIONS = {
  '@langchain/ollama': '0.2.1',
};

const root = process.argv[2] || process.cwd();
const file = path.join(root, 'package.json');

if (!fs.existsSync(file)) {
  console.error(`[resolutions] FAILED: package.json not found in ${root}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.resolutions = pkg.resolutions || {};

let changed = false;
for (const [name, version] of Object.entries(RESOLUTIONS)) {
  if (pkg.resolutions[name] === version) {
    console.log(`[resolutions] already present: ${name}@${version}`);
    continue;
  }
  pkg.resolutions[name] = version;
  changed = true;
  console.log(`[resolutions] pinned: ${name}@${version}`);
}

if (changed) {
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log('[resolutions] package.json updated.');
} else {
  console.log('[resolutions] nothing to do (no-op).');
}
