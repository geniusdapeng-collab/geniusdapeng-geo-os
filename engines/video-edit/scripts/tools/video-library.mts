#!/usr/bin/env tsx
/** Strictly read-only local library CLI, also used by PengManager's video adapter. */
import { readVideoLibrary, resolveVideoCharacters, resolveVideoProduct, VideoLibraryError } from "../../packages/video-studio/src/video-library.js";
import { BuiltinCharacterSelectionError } from "../../packages/video-studio/src/builtin-character-selection.js";

try {
  const [command, raw = "{}", ...rest] = process.argv.slice(2);
  if (rest.length || raw.length > 100_000) throw new VideoLibraryError("VIDEO_LIBRARY_REQUEST_INVALID", "只接受一个JSON参数，最长100KB");
  const input: unknown = JSON.parse(raw);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new VideoLibraryError("VIDEO_LIBRARY_REQUEST_INVALID", "参数必须为JSON对象");
  const data = input as Record<string, unknown>;
  let result: unknown;
  if (command === "catalog" && Object.keys(data).every(key => key === "kind")) result = readVideoLibrary((data.kind ?? "all") as "all");
  else if (command === "characters") result = resolveVideoCharacters(data as { intent: string; metadata?: Record<string, unknown> });
  else if (command === "product" && Object.keys(data).every(key => key === "selector")) result = resolveVideoProduct(data.selector as string);
  else throw new VideoLibraryError("VIDEO_LIBRARY_COMMAND_INVALID", "命令只接受catalog、characters或product及其明确参数");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const known = error instanceof VideoLibraryError || error instanceof BuiltinCharacterSelectionError;
  const status = error instanceof VideoLibraryError ? error.status : error instanceof BuiltinCharacterSelectionError && error.kind === "selection" ? 400 : 503;
  process.stderr.write(`${JSON.stringify({ error: { code: error instanceof VideoLibraryError ? error.code : error instanceof BuiltinCharacterSelectionError ? "VIDEO_CHARACTER_SELECTION_INVALID" : "VIDEO_LIBRARY_UNAVAILABLE",
    status, message: known ? error.message : "本地视频资产或完整性证据不可核实。" } })}\n`);
  process.exitCode = 1;
}
