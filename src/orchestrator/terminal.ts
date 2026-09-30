// PTY abstraction, output ring buffer and ANSI stripping.
import * as pty from 'node-pty';
import { ptyArgs } from '../core/claude.js';
import { killTree } from '../core/git.js';

export interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** Spawns a process in a pseudo-terminal. Injectable so tests never start real `claude`. */
export type PtyLauncher = (file: string, args: string[], opts: PtySpawnOptions) => PtyProcess;

export const nodePtyLauncher: PtyLauncher = (file, args, opts) => {
  const p = pty.spawn(file, ptyArgs(file, args), { name: 'xterm-256color', ...opts });
  return {
    pid: p.pid,
    onData: (cb) => void p.onData(cb),
    onExit: (cb) => void p.onExit(({ exitCode }) => cb({ exitCode })),
    write: (d) => p.write(d),
    resize: (c, r) => {
      try {
        p.resize(c, r);
      } catch {
        /* the process exited between the client's resize and now */
      }
    },
    kill: () => {
      // node-pty's Windows kill() enumerates the console's processes via AttachConsole, which fails in a
      // detached, console-less orchestrator; taskkill /T takes down claude and its MCP/hook children instead.
      if (process.platform === 'win32') return killTree(p.pid);
      try {
        p.kill();
      } catch {
        /* already exited */
      }
    },
  };
};

/** Keeps the most recent `max` characters of terminal output. */
export class RingBuffer {
  private chunks: string[] = [];
  private size = 0;

  constructor(private max = 200 * 1024) {}

  push(data: string): void {
    this.chunks.push(data);
    this.size += data.length;
    while (this.size - this.chunks[0].length >= this.max) this.size -= this.chunks.shift()!.length;
    if (this.size > this.max) {
      this.chunks[0] = this.chunks[0].slice(this.size - this.max);
      this.size = this.max;
    }
  }

  text(): string {
    return this.chunks.join('');
  }
}

/**
 * Best-effort plain text from terminal output. ConPTY repaints with cursor moves rather
 * than newlines and spaces, so cursor-position sequences become line breaks and cursor-forward becomes spaces.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[HfBE]/g, '\n')
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Number(n) || 1))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd())
    .join('\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function lastLines(raw: string, n: number): string {
  const lines = stripAnsi(raw).split('\n');
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines
    .filter((l, i, all) => l || all[i - 1]) // squeeze runs of blank lines
    .slice(-n)
    .join('\n');
}
