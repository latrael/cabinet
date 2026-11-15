import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TranscriberOptions {
  whisperBin?: string;
  ffmpegBin?: string;
  model?: string;
  language?: string; // 'auto' by default
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function which(cmd: string): string | null {
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean).concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])) {
    for (const suffix of suffixes) {
      const path = join(dir, cmd + suffix);
      if (executable(path)) return path;
    }
  }
  return null;
}

export function defaultWhisperModel(): string {
  return process.env.CABINET_WHISPER_MODEL ?? join(homedir(), '.cache', 'cabinet', 'whisper', 'ggml-base.bin');
}

/**
 * Local speech-to-text with whisper.cpp. Audio is converted to 16 kHz mono WAV with ffmpeg first.
 * Nothing leaves the machine.
 */
export class WhisperTranscriber {
  private opts: TranscriberOptions;
  constructor(opts: TranscriberOptions = {}) {
    this.opts = opts;
  }

  private async bins() {
    const whisper = this.opts.whisperBin ?? process.env.CABINET_WHISPER_BIN ?? which('whisper-cli') ?? which('whisper-cpp');
    const ffmpeg = this.opts.ffmpegBin ?? process.env.CABINET_FFMPEG_BIN ?? which('ffmpeg');
    return { whisper, ffmpeg, model: this.opts.model ?? defaultWhisperModel() };
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.bins();
    if (!b.ffmpeg || !executable(b.ffmpeg)) return { ok: false, reason: 'ffmpeg not found (brew install ffmpeg)' };
    if (!b.whisper || !executable(b.whisper)) return { ok: false, reason: 'whisper.cpp not found (brew install whisper-cpp)' };
    if (!existsSync(b.model) || !statSync(b.model).isFile()) return { ok: false, reason: `model missing at ${b.model}` };
    return { ok: true };
  }

  async transcribe(audioPath: string): Promise<string> {
    const b = await this.bins();
    const a = await this.available();
    if (!a.ok) throw new Error(`Transcription unavailable: ${a.reason}`);
    const dir = mkdtempSync(join(tmpdir(), 'cabinet-whisper-'));
    try {
      const wav = join(dir, 'audio.wav');
      await run(b.ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { timeout: 120_000 });
      const out = join(dir, 'out');
      await run(b.whisper!, ['-m', b.model, '-f', wav, '-l', this.opts.language ?? 'auto', '-otxt', '-of', out, '-np', '-nt'], { timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 });
      return readFileSync(out + '.txt', 'utf8')
        .replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]/gi, '')
        .replace(/\s+\n/g, '\n')
        .trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function createTranscriber(_ctx?: unknown) {
  return new WhisperTranscriber();
}
