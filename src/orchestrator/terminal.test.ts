import { describe, expect, it } from 'vitest';
import { lastLines, nodePtyLauncher, RingBuffer, stripAnsi } from './terminal.js';

describe('terminal helpers', () => {
  it('ring buffer keeps only the newest characters', () => {
    const b = new RingBuffer(10);
    b.push('abcdef');
    b.push('ghijkl');
    expect(b.text()).toBe('cdefghijkl');
    b.push('0123456789XYZ');
    expect(b.text()).toBe('3456789XYZ');
  });

  it('strips ANSI and turns cursor moves into line breaks', () => {
    const raw = '\x1b[?25l\x1b[2J\x1b[m\x1b[Hhi\r\n\x1b]0;C:\\cmd.exe\x07\x1b[32mgreen\x1b[0m\x1b[3;1Hnext\rover';
    expect(stripAnsi(raw)).toBe('\nhi\ngreen\nover');
    expect(lastLines('a\n\n\n\nb\nc\n\n', 2)).toBe('b\nc');
  });
});

// Real PTY smoke test: ConPTY on Windows, forkpty elsewhere.
describe('node-pty launcher', () => {
  it('delivers output of a real process', async () => {
    const [file, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'echo muster-pty-ok']] : ['sh', ['-c', 'echo muster-pty-ok']];
    const p = nodePtyLauncher(file, args as string[], { cwd: process.cwd(), env: process.env as Record<string, string>, cols: 80, rows: 24 });
    const buf = new RingBuffer();
    p.onData((d) => buf.push(d));
    const code = await new Promise<number>((r) => p.onExit((e) => r(e.exitCode)));
    expect(code).toBe(0);
    expect(stripAnsi(buf.text())).toContain('muster-pty-ok');
  }, 20_000);
});
