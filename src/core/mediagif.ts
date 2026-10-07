// Demo GIF rendering with ffmpeg (docs/MEDIA.md "Demo GIF"): a slideshow of evidence screenshots with captions burned
// in, or a crew member's recording turned into a GIF with the same captions spread over it. Both land in
// .muster/media/<piece id>/ at 800×500 on the app's background, 12 fps, with a generated palette, looping forever.
// ffmpeg comes from MUSTER_FFMPEG, else PATH. The process runner is injectable for tests.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { MediaGifFile } from '../types.js';
import { nowIso } from './board.js';

export const GIF_WIDTH = 800;
export const GIF_HEIGHT = 500;
export const GIF_FPS = 12; // recordings
/** Slideshows are stills: 2 fps keeps their 0.5 s timing steps and the file small (repeated frames cost almost nothing). */
export const SLIDE_FPS = 2;
export const GIF_BG = '0x111113';
/** A recording longer than this is cut (a GIF is a short demo, and platforms cap the size). */
export const MAX_RECORDING_SECONDS = 30;
export const FFMPEG_MISSING = 'ffmpeg not found: install it with winget install Gyan.FFmpeg';

export interface RunResult {
  code: number;
  stderr: string;
}
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

/** Runs a process without a shell; resolves with its exit code and the tail of stderr. */
export const runProcess: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-20_000);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });

/** ffmpeg's path: MUSTER_FFMPEG when set, else the first ffmpeg(.exe) on PATH, else undefined. */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  if (env.MUSTER_FFMPEG?.trim()) return env.MUSTER_FFMPEG.trim();
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir.replace(/^"|"$/g, ''), n);
      if (exists(p)) return p;
    }
  }
  return undefined;
}

const FONTS = ['C:/Windows/Fonts/seguisb.ttf', 'C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Helvetica.ttc'];

/** A caption font file: Segoe UI Semibold, else Segoe UI / Arial (Windows), else DejaVu / Helvetica. */
export function findFont(exists: (p: string) => boolean = existsSync): string | undefined {
  return FONTS.find((f) => exists(f));
}

/** A path as a quoted value inside an ffmpeg filtergraph: forward slashes, `:` `'` and `\` escaped. */
export function filterPath(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;
}

/** The fit-and-pad chain every frame goes through: 800×500 on the app background, square pixels. */
const FIT = `scale=${GIF_WIDTH}:${GIF_HEIGHT}:force_original_aspect_ratio=decrease,pad=${GIF_WIDTH}:${GIF_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${GIF_BG},setsar=1`;

/** drawtext for one caption read from a file (so no caption text is ever parsed as filter syntax). */
function drawtext(textFile: string, font: string | undefined, enable?: string): string {
  const opts = [
    ...(font ? [`fontfile=${filterPath(font)}`] : []),
    `textfile=${filterPath(textFile)}`,
    'expansion=none', // a caption is literal text ("50% done"), never %{…} expansions
    'fontcolor=white',
    'fontsize=26',
    'box=1',
    'boxcolor=0x0A0A0C@0.82',
    'boxborderw=14',
    'x=36',
    'y=h-th-44',
  ];
  if (enable) opts.push(`enable='${enable}'`);
  return `drawtext=${opts.join(':')}`;
}

/** Slideshow: a palette per frame (stills change completely between frames, so one shared palette loses colours). */
const PALETTE_PER_FRAME = 'split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=bayer:bayer_scale=4';
/** Recording: one palette from every frame (a screen recording keeps the same colours throughout). */
const PALETTE = 'split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';

export interface SlideFrame {
  path: string; // absolute image path
  caption: string;
  seconds: number;
}

export interface RenderOptions {
  ffmpeg?: string; // default findFfmpeg()
  run?: Runner;
  font?: string | null; // null = no font file (tests); default findFont()
}

/** Writes caption files into `dir/.captions/` and returns their paths (empty captions → undefined). */
function captionFiles(dir: string, prefix: string, captions: string[]): (string | undefined)[] {
  const capDir = join(dir, '.captions');
  mkdirSync(capDir, { recursive: true });
  return captions.map((c, i) => {
    const t = c.trim();
    if (!t) return undefined;
    const f = join(capDir, `${prefix}-${i + 1}.txt`);
    writeFileSync(f, t, 'utf8');
    return f;
  });
}

/** The ffmpeg arguments for a slideshow (exported for tests). */
export function slideshowArgs(frames: SlideFrame[], captions: (string | undefined)[], out: string, font: string | undefined): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  // No -loop on the inputs (the gif demuxer has none): each still is held with tpad (before fps, which drops a
  // lone frame), then trimmed to its length.
  for (const f of frames) args.push('-i', f.path);
  const chains = frames.map(
    (f, i) => `[${i}:v]${FIT},tpad=stop_mode=clone:stop_duration=${f.seconds},fps=${SLIDE_FPS},trim=duration=${f.seconds},setpts=PTS-STARTPTS${captions[i] ? `,${drawtext(captions[i]!, font)}` : ''}[v${i}]`,
  );
  const concat = `${frames.map((_f, i) => `[v${i}]`).join('')}concat=n=${frames.length}:v=1:a=0,${PALETTE_PER_FRAME}`;
  args.push('-filter_complex', [...chains, concat].join(';'), '-loop', '0', '-f', 'gif', out);
  return args;
}

/** The ffmpeg arguments for a recording → GIF, with the captions spread evenly over `seconds` (exported for tests). */
export function recordingArgs(input: string, captions: (string | undefined)[], seconds: number, out: string, font: string | undefined): string[] {
  const n = captions.length;
  const slot = n ? seconds / n : seconds;
  const texts = captions
    .map((c, i) => (c ? drawtext(c, font, `between(t,${(i * slot).toFixed(2)},${((i + 1) * slot).toFixed(2)})`) : undefined))
    .filter((x): x is string => !!x);
  const chain = [`fps=${GIF_FPS}`, FIT, ...texts].join(',');
  return ['-hide_banner', '-loglevel', 'error', '-y', '-t', String(MAX_RECORDING_SECONDS), '-i', input, '-filter_complex', `[0:v]${chain},${PALETTE}`, '-loop', '0', '-f', 'gif', out];
}

/** "Duration: 00:00:09.52" from `ffmpeg -i <file>` (which exits 1 with no output file); undefined when unknown. */
export function parseDuration(stderr: string): number | undefined {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function lastLines(stderr: string): string {
  return stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300) || 'no output';
}

/** Runs ffmpeg into `<dir>/<name>.tmp.gif`, then renames it into place and describes the file. */
async function produce(dir: string, name: string, args: (tmp: string) => string[], seconds: number, o: RenderOptions & { ffmpeg: string }): Promise<MediaGifFile> {
  const out = join(dir, name);
  const tmp = join(dir, `${name}.tmp.gif`);
  const run = o.run ?? runProcess;
  let res: RunResult;
  try {
    res = await run(o.ffmpeg, args(tmp));
  } catch (e) {
    throw new Error(`ffmpeg could not start (${o.ffmpeg}): ${e instanceof Error ? e.message : e}`);
  }
  if (res.code !== 0 || !existsSync(tmp)) {
    rmSync(tmp, { force: true });
    throw new Error(`ffmpeg failed: ${lastLines(res.stderr)}`);
  }
  renameSync(tmp, out);
  return { name, bytes: statSync(out).size, width: GIF_WIDTH, height: GIF_HEIGHT, seconds: Math.round(seconds * 10) / 10, renderedAt: nowIso() };
}

function resolveTools(o: RenderOptions): RenderOptions & { ffmpeg: string; fontFile: string | undefined } {
  const ffmpeg = o.ffmpeg ?? findFfmpeg();
  if (!ffmpeg) throw new Error(FFMPEG_MISSING);
  return { ...o, ffmpeg, fontFile: o.font === null ? undefined : (o.font ?? findFont()) };
}

/** Renders `<dir>/slideshow.gif` from evidence screenshots. Throws with a short reason on failure. */
export async function renderSlideshow(dir: string, frames: SlideFrame[], o: RenderOptions = {}): Promise<MediaGifFile> {
  if (!frames.length) throw new Error('no frames to render');
  for (const f of frames) if (!existsSync(f.path)) throw new Error(`missing screenshot ${f.path}`);
  const t = resolveTools(o);
  mkdirSync(dir, { recursive: true });
  const caps = captionFiles(dir, 'slide', frames.map((f) => f.caption));
  const seconds = frames.reduce((n, f) => n + f.seconds, 0);
  return produce(dir, 'slideshow.gif', (tmp) => slideshowArgs(frames, caps, tmp, t.fontFile), seconds, t);
}

/** Turns a recording (video or GIF) into `<dir>/recording.gif` with the captions spread over it. */
export async function convertRecording(dir: string, input: string, captions: string[], o: RenderOptions = {}): Promise<MediaGifFile> {
  if (!existsSync(input)) throw new Error(`missing recording ${input}`);
  const t = resolveTools(o);
  mkdirSync(dir, { recursive: true });
  const run = t.run ?? runProcess;
  const probe = await run(t.ffmpeg, ['-hide_banner', '-i', input]).catch(() => ({ code: 1, stderr: '' }));
  const full = parseDuration(probe.stderr) ?? MAX_RECORDING_SECONDS;
  const seconds = Math.min(full, MAX_RECORDING_SECONDS);
  const caps = captionFiles(dir, 'rec', captions);
  return produce(dir, 'recording.gif', (tmp) => recordingArgs(input, caps, seconds, tmp, t.fontFile), seconds, t);
}
