import { join } from 'node:path';
import { expect, test } from 'vitest';
import { WhisperTranscriber } from '../src/transcribe.ts';
import { tempDir } from '../../core/test/helpers.ts';

test('reports missing executables before trying to decode audio', async () => {
  const t = tempDir();
  try {
    const transcriber = new WhisperTranscriber({ ffmpegBin: join(t.dir, 'absent-ffmpeg') });
    expect(await transcriber.available()).toMatchObject({ ok: false, reason: expect.stringContaining('ffmpeg not found') });
    await expect(transcriber.transcribe('voice.ogg')).rejects.toThrow('Transcription unavailable');
  } finally {
    t.cleanup();
  }
});
