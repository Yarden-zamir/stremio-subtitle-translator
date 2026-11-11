import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { env } from "./env.ts";
import type { Language } from "./languages.ts";
import { formatSrt, parseSubtitle, type Cue } from "./srt.ts";
import type { Translator } from "./translators.ts";

await mkdir(env.CACHE_DIR, { recursive: true });

export function jobKey(translator: Translator, target: Language, sourceUrl: string): string {
  return new Bun.CryptoHasher("sha256").update([translator.cacheId, target.code, sourceUrl].join("\n")).digest("hex").slice(0, 32);
}

export function cachedFile(key: string) {
  return Bun.file(join(env.CACHE_DIR, `${key}.srt`));
}

/** `complete` is false for partial files. Those are not cached, so the next request tries again. */
export type SubtitleResult = { srt: string; complete: boolean };

type Job = {
  /** Undefined until the source file is downloaded and parsed. */
  cues: Cue[] | undefined;
  /** Filled in as batches finish, so a partial file can be served. */
  translated: (string | undefined)[];
  done: Promise<SubtitleResult>;
};

const running = new Map<string, Job>();

/** Starts the translation, or returns the job that already runs for the same key. */
export function startJob(translator: Translator, target: Language, sourceUrl: string): Job {
  const key = jobKey(translator, target, sourceUrl);
  const existing = running.get(key);
  if (existing) return existing;

  const job: Job = { cues: undefined, translated: [], done: Promise.resolve({ srt: "", complete: false }) };
  job.done = runJob(job, translator, target, sourceUrl, key).finally(() => running.delete(key));
  // Callers can drop the job (prefetch, or a player that gave up). Log the error once here.
  job.done.catch((error) => console.error(`Translation ${key} failed:`, error));
  running.set(key, job);
  return job;
}

/**
 * Waits up to SUBTITLE_WAIT_SECONDS for the translation. After that, returns the cues that are done,
 * and the English text with a marker for the rest, because the player does not wait for minutes.
 * Translation starts at the first cue, so a video played from the start gets translated lines first.
 */
export async function getSubtitle(translator: Translator, target: Language, sourceUrl: string): Promise<SubtitleResult> {
  const file = cachedFile(jobKey(translator, target, sourceUrl));
  if (await file.exists()) return { srt: await file.text(), complete: true };

  const job = startJob(translator, target, sourceUrl);
  const finished = await Promise.race([job.done, Bun.sleep(env.SUBTITLE_WAIT_SECONDS * 1000).then(() => undefined)]);
  if (finished) return finished;

  const cues = job.cues ?? [{ timing: "00:00:00,000 --> 00:00:10,000", text: "Downloading subtitle" }];
  console.log(`Serving partial translation: ${job.translated.filter((t) => t !== undefined).length} of ${cues.length} cues`);
  return { srt: withFallback(cues, job.translated, "⏳"), complete: false };
}

/** Untranslated cues keep the English text behind a marker, so the timings stay complete. */
function withFallback(cues: readonly Cue[], translated: readonly (string | undefined)[], marker: string): string {
  return formatSrt(cues.map((cue, i) => ({ timing: cue.timing, text: translated[i] ?? `${marker} ${cue.text}` })));
}

async function runJob(job: Job, translator: Translator, target: Language, sourceUrl: string, key: string): Promise<SubtitleResult> {
  const started = performance.now();
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Subtitle download returned HTTP ${response.status}`);
  const cues = parseSubtitle(await response.text());
  job.cues = cues;

  const batchStarts: number[] = [];
  for (let i = 0; i < cues.length; i += translator.batchSize) batchStarts.push(i);
  const errors: unknown[] = [];
  await mapWithConcurrency(batchStarts, env.TRANSLATE_CONCURRENCY, async (start) => {
    const lines = cues.slice(start, start + translator.batchSize).map((cue) => cue.text);
    try {
      const result = await translateBatch(translator, lines, target);
      result.forEach((text, offset) => (job.translated[start + offset] = text));
    } catch (error) {
      // One failed batch must not cost the whole file. Its cues stay English.
      errors.push(error);
    }
  });

  if (errors.length > 0) {
    console.error(`Translation ${key}: ${errors.length} of ${batchStarts.length} batches failed. First error:`, errors[0]);
    // The notice has no translation, so withFallback gives it the ⚠ marker like the English cues.
    const notice = { timing: "00:00:00,000 --> 00:00:08,000", text: "Part of the translation failed. Lines with ⚠ are English. Select the track again to retry." };
    return { srt: withFallback([notice, ...cues], [undefined, ...job.translated], "⚠"), complete: false };
  }

  const srt = formatSrt(cues.map((cue, i) => ({ timing: cue.timing, text: job.translated[i]! })));
  await pruneCache(Buffer.byteLength(srt));
  await Bun.write(cachedFile(key), srt);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`Translated ${cues.length} cues to ${target.name} with ${translator.cacheId} in ${seconds}s`);
  return { srt, complete: true };
}

/**
 * Deletes the oldest cached files until a new file of `incomingBytes` fits in CACHE_MAX_MB.
 * Reads the whole folder on each write. Revisit if the cache holds many thousands of files.
 */
async function pruneCache(incomingBytes: number): Promise<void> {
  const limit = env.CACHE_MAX_MB * 1024 * 1024;
  const files = await Promise.all(
    (await readdir(env.CACHE_DIR)).map(async (name) => {
      const path = join(env.CACHE_DIR, name);
      const info = await stat(path);
      return { path, size: info.size, modified: info.mtimeMs };
    }),
  );
  let total = files.reduce((sum, file) => sum + file.size, incomingBytes);
  for (const file of files.toSorted((a, b) => a.modified - b.modified)) {
    if (total <= limit) break;
    await rm(file.path, { force: true });
    total -= file.size;
  }
}

/**
 * LLMs sometimes return a different number of lines than they get.
 * Then translate each half on its own, down to single cues, so the timings stay aligned.
 */
async function translateBatch(translator: Translator, lines: string[], target: Language): Promise<string[]> {
  const result = await translator.translate(lines, target);
  if (result.length === lines.length) return result;
  if (lines.length === 1) throw new Error(`${translator.cacheId} returned ${result.length} lines for 1 cue`);
  console.warn(`${translator.cacheId} returned ${result.length} of ${lines.length} lines. Splitting the batch.`);
  const middle = Math.ceil(lines.length / 2);
  const [first, second] = await Promise.all([
    translateBatch(translator, lines.slice(0, middle), target),
    translateBatch(translator, lines.slice(middle), target),
  ]);
  return [...first, ...second];
}

/** Workers take items in order, so early items finish first. */
async function mapWithConcurrency<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
