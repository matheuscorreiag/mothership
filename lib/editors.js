// "Open in…": the chat's folder in a code editor on this Mac. Only a browser on
// this Mac gets the button (the server checks again) — from a phone it would
// open a window on a screen nobody is looking at.

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fromThisMac, HttpError, sendJson, readJson } from './config.js';

const run = promisify(execFile);

// By bundle id, so an editor is found wherever it's installed. More can join.
const EDITORS = [{ id: 'vscode', name: 'VS Code', bundle: 'com.microsoft.VSCode' }];

let installed = null; // { at, list }

// The editors this Mac has, asked of Launch Services. Cached a while: one may
// be installed or removed while the server runs.
export async function editors() {
  if (installed && Date.now() - installed.at < 60_000) return installed.list;
  const bundles = JSON.stringify(EDITORS.map((e) => e.bundle));
  const script = `ObjC.import('AppKit'); JSON.stringify(${bundles}.filter((id) => !$.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id).isNil()))`;
  const found = await run('osascript', ['-l', 'JavaScript', '-e', script]).then(({ stdout }) => JSON.parse(stdout), () => []);
  installed = { at: Date.now(), list: EDITORS.filter((e) => found.includes(e.bundle)).map(({ id, name }) => ({ id, name })) };
  return installed.list;
}

// POST /api/open-in { editor, dir }. Returns false when the path isn't this one.
export async function handleEditorApi(req, res, url) {
  if (url.pathname !== '/api/open-in') return false;
  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
  if (!fromThisMac(req)) throw new HttpError(403, 'only a browser on this Mac can open an editor');
  const { editor, dir } = await readJson(req);
  const app = EDITORS.find((e) => e.id === editor);
  if (!app) throw new HttpError(400, 'unknown editor');
  // Absolute, so it can't pass for one of open's flags.
  const st = typeof dir === 'string' && path.isAbsolute(dir) ? await fsp.stat(dir).catch(() => null) : null;
  if (!st?.isDirectory()) throw new HttpError(400, typeof dir === 'string' ? `that folder is gone: ${dir}` : 'no folder given');
  await run('open', ['-b', app.bundle, dir]).catch(() => {
    throw new HttpError(500, `couldn't open ${app.name}`);
  });
  sendJson(res, 200, { ok: true });
  return true;
}
