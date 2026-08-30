// Child process entry point for the Electron app.
// All console output is intercepted and sent as JSON events on stdout.
// Signals are received as JSON lines on stdin.

import fs from 'fs';
import { run } from './runner.js';
import { runFpPush } from './fp-runner.js';
import { setPaused } from './automation.js';
import type { DiffResult, DiffChoice } from './types.js';
import type { FpInspectionForBsi } from './core/fp-bsi.js';

// ── stdio interception ────────────────────────────────────────────────────────

const _stdoutWrite = process.stdout.write.bind(process.stdout);

function send(event: Record<string, unknown>): void {
  _stdoutWrite(JSON.stringify(event) + '\n');
}

(process.stdout as NodeJS.WriteStream & { write: typeof process.stdout.write }).write =
  (chunk: unknown, ...rest: unknown[]): boolean => {
    const str = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (str.trim()) send({ type: 'log', message: str });
    return true;
  };

console.log = (...args: unknown[]) => send({ type: 'log', message: args.map(String).join(' ') });
console.error = (...args: unknown[]) => send({ type: 'log', message: '[ERROR] ' + args.map(String).join(' ') });
console.warn = (...args: unknown[]) => send({ type: 'log', message: '[WARN] ' + args.map(String).join(' ') });

// ── stdin reader ──────────────────────────────────────────────────────────────

type SignalCallback = (msg: Record<string, unknown>) => void;
let signalCallback: SignalCallback | null = null;
let stdinBuffer = '';

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.type === 'pause') {
        setPaused(true);
        send({ type: 'paused' });
        continue;
      }
      if (msg.type === 'resume') {
        setPaused(false);
        send({ type: 'resumed' });
        continue;
      }
      if (signalCallback) {
        const cb = signalCallback;
        signalCallback = null;
        cb(msg);
      }
    } catch { /* ignore non-JSON */ }
  }
});

function waitForSignal(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => { signalCallback = resolve; });
}

// ── Callbacks ─────────────────────────────────────────────────────────────────

async function waitForAnalyzeReady(): Promise<void> {
  send({ type: 'waiting-for-ready' });
  await waitForSignal(); // expects {type:'ready'}
}

async function waitForDiffChoice(diff: DiffResult): Promise<DiffChoice> {
  send({ type: 'diff', result: diff });
  const msg = await waitForSignal(); // expects {type:'choice',value:'all'|'boxes-only'|'cancel'}
  return (msg.value as DiffChoice) ?? 'cancel';
}

// ── main ──────────────────────────────────────────────────────────────────────

const logsDir = process.env['BATAVIA_LOGS_DIR'];

// Two jobs share this process: the ladder CSV import, and pushing fall
// protection records onto a work order. The fall protection payload arrives as
// a FILE rather than on argv — a few hundred records is far past what a command
// line will carry, and truncation there would silently push a partial run.
if (process.argv[2] === '--fp') {
  const payloadPath = process.argv[3];
  if (!payloadPath) {
    send({ type: 'error', message: 'No fall protection payload provided.' });
    process.exit(1);
  }

  let items: FpInspectionForBsi[];
  try {
    items = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  } catch (err: unknown) {
    send({ type: 'error', message: 'Could not read the records to push: ' + String(err) });
    process.exit(1);
  }

  runFpPush(items, {
    waitForReady: async () => {
      send({ type: 'waiting-for-ready' });
      await waitForSignal(); // expects {type:'ready'}
    },
    // Sent the instant a box lands so the parent can persist it. If this
    // process dies on the next item, what already went in is not lost.
    onPushed: (rec) => send({ type: 'fp-pushed', ...rec }),
  })
    .then((result) => { send({ type: 'complete', ...result }); })
    .catch((err: unknown) => {
      send({ type: 'error', message: String(err) });
      process.exit(1);
    });
} else {
  const csvPath = process.argv[2];

  if (!csvPath) {
    send({ type: 'error', message: 'No CSV path provided.' });
    process.exit(1);
  }

  run(csvPath, { waitForAnalyzeReady, waitForDiffChoice }, logsDir)
    .then((result) => {
      send({ type: 'complete', ...result });
    })
    .catch((err: unknown) => {
      send({ type: 'error', message: String(err) });
      process.exit(1);
    });
}
