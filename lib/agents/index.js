// Provider registry and isolated configuration. process.js handles lifetime;
// adapters own their protocols and emit the neutral events in claude.js.

import { createClaudeAgent } from './claude.js';
import { createCodexAgent } from './codex.js';

const ADAPTERS = {
  claude: createClaudeAgent,
  codex: createCodexAgent,
};

export function createAgent(options) {
  const create = ADAPTERS[options.type];
  if (!create) throw new Error(`unknown agent "${options.type}" (available: ${Object.keys(ADAPTERS).join(', ')})`);
  return create(options);
}

// Keep the existing `agent` config as the default. Provider-specific flags
// never bleed into the other provider; `agents` optionally overrides either.
export function createAgents(config) {
  return Object.fromEntries(Object.keys(ADAPTERS).map((type) => {
    const options = {
      command: type, args: type === 'claude' ? ['--dangerously-skip-permissions'] : [],
      cwd: config.agent.cwd, idleMinutes: config.agent.idleMinutes,
      ...(type === config.agent.type ? config.agent : {}), ...config.agents?.[type], type,
    };
    return [type, { options, adapter: createAgent(options) }];
  }));
}
