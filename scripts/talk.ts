/**
 * talk — chat with a SPECIFIC NanoClaw agent from the terminal.
 *
 * Like `pnpm run chat`, but you choose which agent answers. It points the
 * built-in `cli/local` channel at the agent you name, then opens an
 * interactive REPL over the same Unix socket the host already listens on
 * (`data/cli.sock`). No rebuild or restart needed — the router reads wirings
 * fresh from the DB on every message, so the switch takes effect immediately.
 *
 * Usage:
 *   pnpm run talk --agent <name|folder|id>            # interactive REPL
 *   pnpm run talk --agent <ref> hello, what's up      # one-shot message
 *   pnpm run talk --list                              # list agents and exit
 *
 * Mechanics:
 *   - Resolves the agent group by id, folder, or (case-insensitive) name.
 *   - Ensures the `cli/local` messaging group exists and is wired to that
 *     agent, and removes any OTHER `cli/local` wirings so exactly one agent
 *     answers (the `cli` adapter only streams replies back for platform
 *     `local`, so all terminal chat funnels through this one messaging group).
 *   - Connects to the socket and relays your lines through the normal
 *     router → container → delivery path, identical to any channel.
 *
 * Preconditions: the NanoClaw host service must be running.
 */
import net from 'net';
import path from 'path';
import readline from 'readline';

import { DATA_DIR } from '../src/config.js';
import { getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

const CLI_CHANNEL = 'cli';
const CLI_PLATFORM_ID = 'local';
const SILENCE_MS = 1500; // re-show the prompt after this much quiet following a reply
const ONESHOT_TIMEOUT_MS = 120_000; // hard stop for --message mode if no reply arrives

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface Args {
  agentRef?: string;
  message?: string;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  let agentRef: string | undefined;
  const rest: string[] = [];
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent' || a === '-a') {
      agentRef = argv[++i];
    } else if (a === '--list' || a === '-l') {
      list = true;
    } else {
      rest.push(a);
    }
  }
  return { agentRef, message: rest.length ? rest.join(' ') : undefined, list };
}

function listAgents(): void {
  const all = getAllAgentGroups();
  if (all.length === 0) {
    console.error('No agent groups exist yet. Create one with `/init-first-agent` or setup.');
    return;
  }
  console.error('Available agents:');
  for (const ag of all) {
    console.error(`  ${ag.name}  ·  folder=${ag.folder}  ·  id=${ag.id}`);
  }
}

/** Resolve an agent by id, folder, then case-insensitive name. */
function resolveAgent(ref: string): AgentGroup | { ambiguous: AgentGroup[] } | undefined {
  const byId = getAgentGroup(ref);
  if (byId) return byId;
  const byFolder = getAgentGroupByFolder(ref);
  if (byFolder) return byFolder;
  const lower = ref.toLowerCase();
  const byName = getAllAgentGroups().filter((ag) => ag.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return { ambiguous: byName };
  return undefined;
}

/** Point cli/local at `ag` and make sure it's the only agent wired there. */
function wireExclusively(ag: AgentGroup): void {
  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
  if (!mg) {
    mg = {
      id: generateId('mg'),
      channel_type: CLI_CHANNEL,
      platform_id: CLI_PLATFORM_ID,
      name: 'Local CLI',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
  }

  // Drop any other agent wired to cli/local so only the chosen one answers.
  for (const wiring of getMessagingGroupAgents(mg.id)) {
    if (wiring.agent_group_id !== ag.id) {
      const other = getAgentGroup(wiring.agent_group_id);
      console.error(`  · unwiring cli/local from "${other?.name ?? wiring.agent_group_id}"`);
      deleteMessagingGroupAgent(wiring.id);
    }
  }

  if (!getMessagingGroupAgentByPair(mg.id, ag.id)) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
  }
}

/**
 * Open the socket and run the chat. If `oneShot` is set, send it, print the
 * reply, and exit; otherwise drop into an interactive REPL.
 */
function chat(oneShot: string | undefined, agentName: string): void {
  const socket = net.connect(socketPath());
  let rl: readline.Interface | null = null;
  let silenceTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;
  let gotReply = false;
  let buffer = '';

  function shutdown(code: number): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    rl?.close();
    socket.end();
    process.exit(code);
  }

  function promptAgain(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (oneShot !== undefined) {
        shutdown(0);
      } else {
        rl?.prompt();
      }
    }, SILENCE_MS);
  }

  socket.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      console.error(`\nNanoClaw service not reachable at ${socketPath()}.`);
      console.error('Start the host service (launchctl/systemd), then try again.');
    } else {
      console.error('\nCLI socket error:', err);
    }
    process.exit(2);
  });

  socket.on('connect', () => {
    if (oneShot !== undefined) {
      socket.write(JSON.stringify({ text: oneShot }) + '\n');
      hardTimer = setTimeout(() => {
        if (!gotReply) {
          console.error(`\ntimeout: no reply in ${ONESHOT_TIMEOUT_MS}ms`);
          shutdown(3);
        }
      }, ONESHOT_TIMEOUT_MS);
      return;
    }
    console.error(`Talking to "${agentName}". Type a message, or /exit to quit.\n`);
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });
    rl.prompt();
    rl.on('line', (line) => {
      const text = line.trim();
      if (text === '/exit' || text === '/quit' || text === '') {
        if (text === '') return rl!.prompt();
        return shutdown(0);
      }
      socket.write(JSON.stringify({ text }) + '\n');
    });
    rl.on('SIGINT', () => shutdown(0));
  });

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.text === 'string') {
          gotReply = true;
          if (hardTimer) {
            clearTimeout(hardTimer);
            hardTimer = null;
          }
          process.stdout.write('\n' + msg.text + '\n');
          promptAgain();
        }
      } catch {
        // Ignore non-JSON lines (forward compatibility).
      }
    }
  });

  socket.on('close', () => shutdown(0));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  if (args.list) {
    listAgents();
    process.exit(0);
  }

  if (!args.agentRef) {
    console.error('Missing --agent <name|folder|id>.\n');
    listAgents();
    console.error('\nUsage: pnpm run talk --agent <ref> [message...]');
    process.exit(2);
  }

  const resolved = resolveAgent(args.agentRef);
  if (!resolved) {
    console.error(`No agent matches "${args.agentRef}".\n`);
    listAgents();
    process.exit(2);
  }
  if ('ambiguous' in resolved) {
    console.error(`"${args.agentRef}" matches multiple agents — use the folder or id:\n`);
    for (const ag of resolved.ambiguous) {
      console.error(`  ${ag.name}  ·  folder=${ag.folder}  ·  id=${ag.id}`);
    }
    process.exit(2);
  }

  console.error(`Pointing cli/local at "${resolved.name}" (${resolved.folder})…`);
  wireExclusively(resolved);

  chat(args.message, resolved.name);
}

main();
