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
  // @swc/core 1.16.0 is the `latest` tag and the npm registry has QUARANTINED
  // its platform packages, so any fresh install of the Backstage scaffold dies
  // at the first `yarn install`, before a single one of our own packages is
  // added:
  //
  //   YN0016: @swc/core-linux-arm64-gnu@npm:1.16.0:
  //           All versions satisfying "1.16.0" are quarantined
  //
  // It is transitive (the scaffold pulls it through @backstage/cli), so nothing
  // in our Dockerfile asks for it by name and there is no version to bump.
  // 1.15.47 is the last release before the quarantined one.
  //
  // Diagnosis note for whoever revisits this: the first variant to fail was
  // -linux-arm-gnueabihf, which looks like an architecture problem and is not.
  // Restricting supportedArchitectures made yarn skip that variant and fail on
  // -linux-arm64-gnu instead. The whole 1.16.0 release is quarantined; the
  // architecture was the symptom.
  //
  // Remove this pin once 1.16.0 (or a later release) is out of quarantine.
  '@swc/core': '1.15.47',
  // @yarnpkg/core 4.9.2 (published 2026-09-24) leaked a LOCAL yarn patch into its
  // published manifest:
  //
  //   "got": "patch:got@npm%3A11.8.2#~/.yarn/patches/got-npm-11.8.2-c1eb105458.patch"
  //
  // `~/.yarn/patches/` resolves against OUR project root, where that file does not
  // exist, so the first `yarn install` of a fresh scaffold dies in the resolution
  // step with ENOENT on the patch file. It is transitive (via @backstage/cli), and
  // it failed every event provisioned after the release (measured 2026-09-28).
  // 4.9.1 declares "got": "^11.7.0". Remove once a fixed release is out.
  '@yarnpkg/core': '4.9.1',
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
