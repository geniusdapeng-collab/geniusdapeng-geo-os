import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { bytesHash, dataHash, decodeJson, fail, integer, jsonValue, record, requireCondition,
  sha256, throwIfAborted, ContentOpsWorkerError } from './protocol.mjs';

export const MEDIA_VERSION = 'pengmanager.fixed-source-video/v1';
export const MEDIA_PINS = Object.freeze({ ffmpeg: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
  ffprobe: 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64', platform: 'darwin-arm64' });
export const mediaSourceClosureFiles = Object.freeze(['src/content-ops-worker/media.mjs',
  'src/content-ops-worker/protocol.mjs', 'src/domain/hash.mjs', 'src/domain/strict-json.mjs', 'src/domain/errors.mjs',
  'engines/video-edit/bundles/ai-video/connectors/color-bridge/kit/ffmpeg-pin.json']);
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const FILE_INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0'];
const BASE = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1'];
const boundedVideo = (bytes, expected, max) => {
  requireCondition(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'ARTIFACT_INVALID', 'Video sources must contain actual bytes.');
  requireCondition(!(bytes.buffer instanceof SharedArrayBuffer), 'ARTIFACT_INVALID', 'Shared source memory is not permitted.');
  const data = Buffer.from(bytes); sha256(expected);
  requireCondition(data.length >= 16 && data.length <= max && data.toString('ascii', 4, 8) === 'ftyp',
    'NATIVE_ARTIFACT_TYPE_UNSUPPORTED', 'This fixed video adapter requires a bounded real MP4 source.');
  requireCondition(bytesHash(data) === expected, 'ARTIFACT_HASH_MISMATCH', 'The video bytes do not match the frozen source hash.');
  return data;
};
function ordinaryFile(file, expected, max = 150 * 1024 * 1024) {
  requireCondition(typeof file === 'string' && path.isAbsolute(file), 'ADAPTER_NOT_READY', 'A fixed absolute native executable is required.');
  const actual = fs.realpathSync(file); const named = fs.lstatSync(file), stat = fs.statSync(actual);
  // A user-installed .local/bin symlink is resolved once to the exact hash-pinned executable.
  requireCondition((named.isFile() || named.isSymbolicLink()) && stat.isFile() && stat.size > 0 && stat.size <= max,
    'ADAPTER_NOT_READY', 'The fixed native executable is unavailable.');
  requireCondition((stat.mode & 0o022) === 0 && (stat.mode & 0o111) !== 0,
    'ADAPTER_NOT_READY', 'The fixed native executable must not be group/world writable.');
  const fd = fs.openSync(actual, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd); const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
    requireCondition(before.ino === after.ino && before.dev === after.dev && before.size === after.size
      && before.mtimeMs === after.mtimeMs && bytesHash(bytes) === expected, 'ADAPTER_NOT_READY', 'The native executable differs from its verified pin.');
  } finally { fs.closeSync(fd); }
  return actual;
}
function privateDirectory(directory) {
  const requested = path.resolve(directory); const stat = fs.lstatSync(requested);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (!process.getuid || stat.uid === process.getuid()), 'PRIVATE_DIRECTORY_INVALID', 'Media work requires an owner-only ordinary directory.');
  const actual = fs.realpathSync(requested);
  requireCondition(actual !== REPO && !actual.startsWith(REPO + path.sep), 'PRIVATE_DIRECTORY_INVALID', 'Native temporary files must stay outside the checkout.');
  return actual;
}
function writeNew(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readNew(file, maxBytes) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { const stat = fs.fstatSync(fd); requireCondition(stat.isFile() && stat.size > 0 && stat.size <= maxBytes,
    'ARTIFACT_INVALID', 'The fixed native output is missing or too large.'); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}

async function nativeProcess(executable, args, { cwd, signal, timeoutMs, maxBytes }) {
  throwIfAborted(signal); const started = Date.now();
  return await new Promise((resolve, reject) => {
    let child, timer, killTimer, reason = null, closed = false, size = 0, diagnosticBytes = 0;
    const chunks = [];
    const stop = code => {
      if (closed || reason) return; reason = code; child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000); killTimer.unref();
    };
    try { child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: path.dirname(executable), LANG: 'C', LC_ALL: 'C', HOME: cwd, TMPDIR: cwd, AV_LOG_FORCE_NOCOLOR: '1' } }); }
    catch (cause) { reject(new ContentOpsWorkerError('NATIVE_START_FAILED', 'The fixed native media process could not start.', { cause })); return; }
    const abort = () => stop('WORKER_CANCELLED'); signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('NATIVE_DEADLINE_EXCEEDED'), timeoutMs); timer.unref();
    child.stdout.on('data', bytes => { size += bytes.length; if (size > maxBytes) stop('WORKSPACE_QUOTA_EXCEEDED'); else chunks.push(Buffer.from(bytes)); });
    // Never surface untrusted metadata, paths, subtitles or diagnostic bodies.
    child.stderr.on('data', bytes => { diagnosticBytes += bytes.length; if (diagnosticBytes > 128 * 1024) stop('NATIVE_DIAGNOSTIC_LIMIT'); });
    let spawnError = null; child.on('error', error => { spawnError = error; });
    child.once('close', code => {
      closed = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      const elapsedMs = Date.now() - started;
      if (reason || spawnError || code !== 0) {
        const error = new ContentOpsWorkerError(reason ?? 'NATIVE_MEDIA_FAILED', 'The fixed media process did not produce a verified successful result.', { unknown: reason === 'NATIVE_DEADLINE_EXCEEDED' });
        error.execution = { executed: !spawnError, dryRun: false, elapsedMs, nativeProcesses: spawnError ? 0 : 1, exitCode: code };
        reject(error); return;
      }
      resolve({ stdout: Buffer.concat(chunks, size), executed: true, dryRun: false, elapsedMs, nativeProcesses: 1, exitCode: 0 });
    });
  });
}

function probeValue(raw) {
  const value = decodeJson(raw, { maxBytes: 100_000 });
  requireCondition(Array.isArray(value.streams), 'ARTIFACT_INVALID', 'The actual MP4 stream metadata is missing.');
  const videos = value.streams.filter(item => item.codec_type === 'video'), audios = value.streams.filter(item => item.codec_type === 'audio');
  requireCondition(videos.length === 1 && audios.length <= 1 && value.streams.length === videos.length + audios.length,
    'NATIVE_ARTIFACT_TYPE_UNSUPPORTED', 'The fixed video adapter accepts one video and at most one audio stream.');
  const video = videos[0], durationMs = Math.round(Number(value.format?.duration ?? video.duration) * 1000);
  integer(video.width, 'Video width', 16, 3840); integer(video.height, 'Video height', 16, 3840);
  requireCondition(video.width * video.height <= 8_294_400, 'WORKER_RESOURCE_LIMIT', 'The source resolution exceeds the fixed decode limit.');
  integer(durationMs, 'Actual video duration', 1, 600_000);
  const frames = Number(video.nb_read_frames); integer(frames, 'Actually decoded frame count', 1, 36_000);
  return { width: video.width, height: video.height, durationMs, frames, hasAudio: audios.length === 1,
    videoCodec: String(video.codec_name), audioCodec: audios.length ? String(audios[0].codec_name) : null,
    audioSampleRate: audios.length ? Number(audios[0].sample_rate) : null, audioChannels: audios.length ? Number(audios[0].channels) : null };
}

/** Only fixed source-video cut/assembly. No generation, BGM replacement, voice or remote URLs. */
export function createMediaProcessor({ ffmpegPath = path.join(os.homedir(), '.local/bin/ffmpeg'),
  ffprobePath = path.join(os.homedir(), '.local/bin/ffprobe'), workRoot, maxTempBytes = 500 * 1024 * 1024,
  maxRenderMs = 120_000, signal, runNativeCall } = {}) {
  integer(maxTempBytes, 'Media temporary bytes', 1024, 2_000_000_000); integer(maxRenderMs, 'Media deadline', 100, 600_000);
  const dependencies = () => {
    requireCondition(process.platform + '-' + process.arch === MEDIA_PINS.platform, 'ADAPTER_NOT_READY', 'This native video pin has only been verified for darwin-arm64.');
    requireCondition(typeof runNativeCall === 'function', 'ADAPTER_NOT_READY', 'Native media needs the per-process budget dispatch hook.');
    return { ffmpeg: ordinaryFile(ffmpegPath, MEDIA_PINS.ffmpeg), ffprobe: ordinaryFile(ffprobePath, MEDIA_PINS.ffprobe),
      workRoot: privateDirectory(workRoot) };
  };
  const withWorkspace = async action => {
    const deps = dependencies(); throwIfAborted(signal);
    const directory = fs.mkdtempSync(path.join(deps.workRoot, 'video-')); fs.chmodSync(directory, 0o700);
    const started = Date.now(), calls = [];
    const call = async (key, executable, args, maxBytes = maxTempBytes) => {
      throwIfAborted(signal); const remaining = maxRenderMs - (Date.now() - started);
      requireCondition(remaining > 0, 'NATIVE_DEADLINE_EXCEEDED', 'The fixed video task reached its overall deadline.');
      const requestHash = dataHash({ schema: MEDIA_VERSION, key, executableSha: executable === deps.ffmpeg ? MEDIA_PINS.ffmpeg : MEDIA_PINS.ffprobe,
        args: args.map(argument => typeof argument === 'string' ? argument.replaceAll(directory, '<private-workspace>') : argument) });
      let ran = false;
      const result = await runNativeCall({ callKey: key, requestHash, upperBound: { inputTokens: 0, outputTokens: 0,
        renderSeconds: Math.ceil(remaining / 1000), tempBytes: maxTempBytes, nativeProcesses: 1 } }, async ({ signal: dispatchSignal } = {}) => {
        requireCondition(!ran, 'DISPATCH_REPLAY_BLOCKED', 'The native process permit cannot execute twice.'); ran = true;
        const actualSignal = signal && dispatchSignal ? AbortSignal.any([signal, dispatchSignal]) : signal ?? dispatchSignal;
        return await nativeProcess(executable, args, { cwd: directory, signal: actualSignal, timeoutMs: remaining, maxBytes });
      });
      requireCondition(ran && result.executed === true && result.dryRun === false && Buffer.isBuffer(result.stdout)
        && result.exitCode === 0, 'EXECUTION_NOT_VERIFIED', 'The native media dispatch hook did not return a real successful process result.');
      calls.push({ callKey: key, requestHash, nativeProcesses: 1, elapsedMs: result.elapsedMs, exitCode: 0 }); return result.stdout;
    };
    const probe = async (file, key) => probeValue(await call(key, deps.ffprobe, ['-v', 'error', ...FILE_INPUT,
      '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,duration,nb_read_frames,sample_rate,channels:format=duration',
      '-of', 'json', file], 100_000));
    try { return await action({ deps, directory, probe, call, calls, started }); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  };
  return {
    readiness() {
      try { dependencies(); return { ready: true, productionVerified: false, inspection: 'pinned_files_only', pins: MEDIA_PINS }; }
      catch (error) { return { ready: false, productionVerified: false, reason: error.code ?? 'NATIVE_DEPENDENCY_UNAVAILABLE' }; }
    },
    async inspect(input) {
      record(input, 'MP4 inspection', ['bytes', 'sha256']); const bytes = boundedVideo(input.bytes, input.sha256, maxTempBytes);
      return await withWorkspace(async ({ directory, probe, calls }) => {
        const file = path.join(directory, 'source.mp4'); writeNew(file, bytes); const metadata = await probe(file, 'media.probe.source');
        return { mime: 'application/json', bytes: Buffer.from(JSON.stringify({ schema: MEDIA_VERSION, sha256: input.sha256, ...metadata, fullyDecoded: true }) + '\n'),
          metadata: { ...metadata, fullyDecoded: true, sourceSha256: input.sha256, sourceUntouched: true, calls } };
      });
    },
    async renderVideo(input) {
      record(input, 'Fixed source video', ['segments', 'width', 'height', 'fps', 'audioPolicy']);
      requireCondition(Array.isArray(input.segments) && input.segments.length > 0 && input.segments.length <= 12,
        'LOCAL_SOURCE_MISSING', 'Video assembly requires one to twelve actual source segments.');
      requireCondition(input.audioPolicy === 'preserve_original', 'VOICE_PERMISSION_REQUIRED', 'This adapter preserves original audio and does not synthesize or replace voices.');
      const width = integer(input.width, 'Output width', 16, 1920), height = integer(input.height, 'Output height', 16, 1920);
      requireCondition(width % 2 === 0 && height % 2 === 0 && width * height <= 2_073_600, 'WORKER_RESOURCE_LIMIT', 'Output dimensions must fit the fixed 1080p pixel limit.');
      const fps = integer(input.fps ?? 30, 'Output FPS', 24, 30);
      const segments = input.segments.map(segment => {
        record(segment, 'Video segment', ['bytes', 'sha256', 'startMs', 'endMs']);
        const bytes = boundedVideo(segment.bytes, segment.sha256, maxTempBytes);
        return { bytes, sha256: segment.sha256, startMs: integer(segment.startMs ?? 0, 'Segment start', 0, 600_000),
          endMs: integer(segment.endMs, 'Segment end', 1, 600_000) };
      });
      const totalSourceBytes = segments.reduce((sum, item) => sum + item.bytes.length, 0);
      requireCondition(totalSourceBytes < maxTempBytes / 2, 'WORKSPACE_QUOTA_EXCEEDED', 'The fixed video workspace must reserve space for both source and actual output.');
      return await withWorkspace(async ({ deps, directory, probe, call, calls }) => {
        const descriptions = [];
        for (const [index, segment] of segments.entries()) {
          const file = path.join(directory, `source-${index}.mp4`); writeNew(file, segment.bytes);
          const metadata = await probe(file, `media.probe.source.${index}`);
          requireCondition(segment.startMs < segment.endMs && segment.endMs <= metadata.durationMs + 50,
            'CAPTION_TIMING_REQUIRED', 'The requested cut is outside the real source timeline.');
          descriptions.push({ ...metadata, file });
        }
        const hasAudio = descriptions[0].hasAudio;
        requireCondition(descriptions.every(row => row.hasAudio === hasAudio), 'AUDIO_SOURCE_MISMATCH', 'All assembled segments must consistently preserve their existing audio.');
        const expectedDurationMs = segments.reduce((sum, row) => sum + row.endMs - row.startMs, 0);
        requireCondition(expectedDurationMs <= 600_000, 'WORKER_RESOURCE_LIMIT', 'The requested source-video assembly exceeds ten minutes.');
        const args = [...BASE, '-filter_complex_threads', '1'];
        descriptions.forEach(row => args.push(...FILE_INPUT, '-i', row.file));
        const filters = [];
        segments.forEach((row, index) => {
          const start = (row.startMs / 1000).toFixed(3), end = (row.endMs / 1000).toFixed(3);
          filters.push(`[${index}:v:0]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${index}]`);
          if (hasAudio) filters.push(`[${index}:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,aresample=48000[a${index}]`);
        });
        filters.push(segments.map((_, index) => `[v${index}]${hasAudio ? `[a${index}]` : ''}`).join('')
          + `concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`);
        args.push('-filter_complex', filters.join(';'), '-map', '[v]'); if (hasAudio) args.push('-map', '[a]');
        args.push('-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
          '-pix_fmt', 'yuv420p', '-threads', '1');
        if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
        args.push('-t', (expectedDurationMs / 1000).toFixed(3), '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
        const bytes = await call('media.render.video', deps.ffmpeg, args, maxTempBytes - totalSourceBytes);
        boundedVideo(bytes, bytesHash(bytes), maxTempBytes - totalSourceBytes);
        const outputFile = path.join(directory, 'output.mp4'); writeNew(outputFile, bytes);
        const metadata = await probe(outputFile, 'media.probe.output');
        requireCondition(metadata.width === width && metadata.height === height && metadata.hasAudio === hasAudio
          && Math.abs(metadata.durationMs - expectedDurationMs) <= 150 && metadata.frames >= Math.max(1, Math.floor(expectedDurationMs / 1000 * fps) - 2),
        'VIDEO_OUTPUT_MISMATCH', 'The actual decoded video differs from the requested dimensions, audio or timeline.');
        // Probe counted decoded video frames. A second full decode also checks preserved audio.
        await call('media.decode.output', deps.ffmpeg, [...BASE, ...FILE_INPUT, '-i', outputFile,
          '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []), '-f', 'null', '-'], 4096);
        return { bytes: readNew(outputFile, maxTempBytes - totalSourceBytes), mime: 'video/mp4', metadata: {
          schema: MEDIA_VERSION, ...metadata, fps, expectedDurationMs, fullyDecoded: true, sourceUntouched: true,
          audioPolicy: 'preserve_original', originalAudioPresent: hasAudio,
          sourceSegments: segments.map(row => ({ sha256: row.sha256, bytes: row.bytes.length, startMs: row.startMs, endMs: row.endMs })),
          pins: MEDIA_PINS, calls, artisticQuality: 'unverified', semanticQuality: 'unverified' } };
      });
    },
  };
}
