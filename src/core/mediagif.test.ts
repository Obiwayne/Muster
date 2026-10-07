import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertRecording, FFMPEG_MISSING, filterPath, findFfmpeg, parseDuration, recordingArgs, renderSlideshow, slideshowArgs, type Runner } from './mediagif.js';

describe('mediagif helpers', () => {
  it('finds ffmpeg from MUSTER_FFMPEG, then PATH', () => {
    expect(findFfmpeg({ MUSTER_FFMPEG: 'D:/tools/ffmpeg.exe', PATH: '' })).toBe('D:/tools/ffmpeg.exe');
    const dir = process.platform === 'win32' ? 'C:\\bin' : '/opt/bin';
    const sep = process.platform === 'win32' ? ';' : ':';
    const hit = findFfmpeg({ PATH: `/nowhere${sep}${dir}` }, (p) => p.startsWith(dir));
    expect(hit?.startsWith(dir)).toBe(true);
    expect(findFfmpeg({ PATH: '/nowhere' }, () => false)).toBeUndefined();
  });

  it('escapes paths for the filtergraph', () => {
    expect(filterPath('C:\\Windows\\Fonts\\arial.ttf')).toBe("'C\\:/Windows/Fonts/arial.ttf'");
    expect(filterPath("F:/a b/it's.txt")).toBe("'F\\:/a b/it'\\''s.txt'");
  });

  it('builds a slideshow graph: one held, trimmed, captioned chain per frame, then concat and a palette', () => {
    const args = slideshowArgs(
      [
        { path: 'a.png', caption: 'One', seconds: 2 },
        { path: 'b.png', caption: '', seconds: 1.5 },
      ],
      ['C:/cap/1.txt', undefined],
      'out.gif',
      'C:/Windows/Fonts/arial.ttf',
    );
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    expect(args.slice(0, args.indexOf('-filter_complex'))).not.toContain('-loop'); // the gif demuxer has no -loop
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('tpad=stop_mode=clone:stop_duration=2');
    expect(graph).toContain('trim=duration=1.5');
    expect(graph).toContain("textfile='C\\:/cap/1.txt'");
    expect(graph.match(/drawtext/g)).toHaveLength(1); // the empty caption draws nothing
    expect(graph).toContain('concat=n=2:v=1:a=0');
    expect(graph).toContain('palettegen');
    expect(args.slice(-5)).toEqual(['-loop', '0', '-f', 'gif', 'out.gif']);
  });

  it('spreads recording captions evenly over its length', () => {
    const args = recordingArgs('rec.webm', ['c1.txt', 'c2.txt'], 10, 'out.gif', undefined);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain("enable='between(t,0.00,5.00)'");
    expect(graph).toContain("enable='between(t,5.00,10.00)'");
    expect(args).toContain('-t');
  });

  it('parses the duration ffmpeg prints', () => {
    expect(parseDuration('  Duration: 00:01:09.52, start: 0.000000, bitrate: 1 kb/s')).toBeCloseTo(69.52);
    expect(parseDuration('nothing')).toBeUndefined();
  });

  it('reports a missing ffmpeg and a failing run in plain words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgif-'));
    const img = join(dir, 'a.png');
    writeFileSync(img, 'x');
    await expect(renderSlideshow(dir, [{ path: join(dir, 'gone.png'), caption: 'x', seconds: 1 }], { ffmpeg: 'ffmpeg', font: null })).rejects.toThrow(/missing screenshot/);
    const crashing: Runner = async () => {
      throw new Error('spawn ENOENT');
    };
    await expect(renderSlideshow(dir, [{ path: img, caption: 'x', seconds: 1 }], { ffmpeg: 'nope.exe', font: null, run: crashing })).rejects.toThrow(/ffmpeg could not start \(nope\.exe\): spawn ENOENT/);
    const failing: Runner = async () => ({ code: 1, stderr: 'line1\nError opening input' });
    await expect(renderSlideshow(dir, [{ path: img, caption: 'x', seconds: 1 }], { ffmpeg: 'ffmpeg', font: null, run: failing })).rejects.toThrow(/ffmpeg failed: .*Error opening input/);
    expect(existsSync(join(dir, 'slideshow.gif'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    expect(FFMPEG_MISSING).toMatch(/winget install Gyan\.FFmpeg/);
  });
});

const ffmpeg = findFfmpeg();
describe.skipIf(!ffmpeg)('mediagif with the real ffmpeg', () => {
  const root = mkdtempSync(join(tmpdir(), 'mgif real-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('renders a 2-frame slideshow with captions, then converts it as a recording', async () => {
    const a = join(root, 'a.png');
    const b = join(root, "b b's.png"); // a space and a quote in the path
    execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x2DD4BF:s=1200x700', '-frames:v', '1', a]);
    execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xF472B6:s=600x900', '-frames:v', '1', b]);
    const dir = join(root, 'media', 'MP1');
    const file = await renderSlideshow(dir, [
      { path: a, caption: "A student's post: 50% done, ready", seconds: 1 },
      { path: b, caption: 'New posts wait for you first', seconds: 1.5 },
    ]);
    expect(file).toMatchObject({ name: 'slideshow.gif', width: 800, height: 500, seconds: 2.5 });
    const bytes = readFileSync(join(dir, 'slideshow.gif'));
    expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(bytes.readUInt16LE(6)).toBe(800);
    expect(bytes.readUInt16LE(8)).toBe(500);
    expect(file.bytes).toBe(bytes.length);
    if (process.env.MEDIAGIF_SAMPLE) copyFileSync(join(dir, 'slideshow.gif'), process.env.MEDIAGIF_SAMPLE);

    const rec = await convertRecording(dir, join(dir, 'slideshow.gif'), ['Step one', 'Step two']);
    expect(rec).toMatchObject({ name: 'recording.gif', width: 800, height: 500 });
    expect(rec.seconds).toBeGreaterThan(2);
    expect(rec.seconds).toBeLessThan(3);
    expect(readFileSync(join(dir, 'recording.gif')).subarray(0, 6).toString('latin1')).toBe('GIF89a');
  }, 60_000);
});
