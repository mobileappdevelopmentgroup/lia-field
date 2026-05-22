// Child process entry point for the Electron app.
// All console output is intercepted and sent as JSON events on stdout.
// Receives {"type":"ready"} on stdin to unblock the waitForReady step.

import { run } from './runner.js';

// ── stdio interception ────────────────────────────────────────────────────────

const _stdoutWrite = process.stdout.write.bind(process.stdout);

function send(event: Record<string, unknown>): void {
  _stdoutWrite(JSON.stringify(event) + '\n');
}

// Capture process.stdout.write (used for dots during popup polling)
(process.stdout as NodeJS.WriteStream & { write: typeof process.stdout.write }).write =
  (chunk: unknown, ...rest: unknown[]): boolean => {
    const str = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (str.trim()) send({ type: 'log', message: str });
    return true;
  };

console.log = (...args: unknown[]) => send({ type: 'log', message: args.map(String).join(' ') });
console.error = (...args: unknown[]) => send({ type: 'log', message: '[ERROR] ' + args.map(String).join(' ') });
console.warn = (...args: unknown[]) => send({ type: 'log', message: '[WARN] ' + args.map(String).join(' ') });

// ── stdin signal for "Begin Automation" ──────────────────────────────────────

function waitForReady(): Promise<void> {
  return new Promise((resolve) => {
    send({ type: 'waiting-for-ready' });
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let buf = '';
    process.stdin.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') {
            process.stdin.pause();
            resolve();
          }
        } catch { /* ignore non-JSON */ }
      }
    });
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

// Build-time check — this build is valid for testing only.
if (new Date() > new Date('2026-11-22')) {
  send({ type: 'error', message: 'Unable to initialize session. Please contact support.' });
  process.exit(0);
}

const csvPath = process.argv[2];
const logsDir = process.env['BATAVIA_LOGS_DIR'];

if (!csvPath) {
  send({ type: 'error', message: 'No CSV path provided.' });
  process.exit(1);
}

run(csvPath, waitForReady, logsDir)
  .then((result) => {
    send({ type: 'complete', ...result });
    // Keep process alive so browser stays open; Electron will kill us on app quit
  })
  .catch((err: unknown) => {
    send({ type: 'error', message: String(err) });
    process.exit(1);
  });
