// Process lifetime is shared; each adapter owns its wire protocol.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { cleanEnv } from '../config.js';

export function startAgent(agent, options) {
  const { command, args } = agent.spawnArgs(options);
  const child = spawn(command, args, { cwd: options.cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let ended = false;
  let stopped = false;
  let killTimer;
  const write = (message) => {
    if (ended || stopped) throw new Error('The agent process is closed');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const emit = (event) => { if (!stopped) options.onEvent?.(event); };
  const parse = agent.createParser?.();
  const connection = agent.createConnection
    ? agent.createConnection({ ...options, write, emit })
    : {
        receive: (raw) => { for (const event of parse(raw)) emit(event); },
        send: (message) => write(agent.userMessage(message)),
        interrupt: () => write(agent.interruptMessage(crypto.randomUUID())),
      };
  const exit = (error, code) => {
    if (ended) return;
    ended = true;
    clearTimeout(killTimer);
    connection.close?.(new Error(error || stderr.trim().split('\n').slice(-6).join('\n') || `exit code ${code}`));
    if (!stopped) options.onExit?.(error || stderr.trim().split('\n').slice(-6).join('\n'), code);
  };
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let raw;
    try { raw = JSON.parse(line); } catch { return; }
    if (stopped) return;
    try { connection.receive(raw); } catch (err) { exit(err.message); child.kill(); }
  });
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
  child.stdin.on('error', () => {}); // close reports EPIPE with stderr
  child.on('error', (err) => exit(err.message));
  child.on('close', (code, signal) => exit(null, code ?? signal));
  return {
    send: (message) => connection.send(message),
    interrupt: () => connection.interrupt(),
    discover: () => connection.discover(),
    kill: (signal = 'SIGTERM') => child.kill(signal),
    stop() {
      stopped = true;
      connection.close?.(new Error('The agent process was stopped'));
      child.stdin.end();
      if (!ended) killTimer = setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    },
  };
}
