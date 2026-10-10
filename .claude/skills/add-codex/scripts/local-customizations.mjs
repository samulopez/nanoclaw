import fs from 'node:fs';

// Keep this install's pre-existing Codex fixes after each registry refresh.
const runtimePath = 'container/agent-runner/src/providers/codex.ts';
const serverPath = 'container/agent-runner/src/providers/codex-app-server.ts';
let runtime = fs.readFileSync(runtimePath, 'utf8');
if (!/const TURN_TIMEOUT_MS = (10|30) \* 60 \* 1000;/.test(runtime)) {
  throw new Error('Codex timeout seam changed; review the local 30-minute limit');
}
runtime = runtime.replace('const TURN_TIMEOUT_MS = 10 * 60 * 1000;', 'const TURN_TIMEOUT_MS = 30 * 60 * 1000;');
fs.writeFileSync(runtimePath, runtime);
let server = fs.readFileSync(serverPath, 'utf8');
if (!server.includes("  'GIT_HTTP_PROXY_AUTHMETHOD',")) {
  if (!server.includes("  'GIT_SSL_CAINFO',")) throw new Error('Codex environment allowlist seam changed');
  server = server.replace("  'GIT_SSL_CAINFO',", "  'GIT_HTTP_PROXY_AUTHMETHOD',\n  'GIT_SSL_CAINFO',");
  fs.writeFileSync(serverPath, server);
}
