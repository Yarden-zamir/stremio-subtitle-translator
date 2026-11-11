import { z } from "zod";

const optionalString = z.string().trim().min(1).optional();

/** Strips "/manifest.json" and a trailing slash, so both addon URL forms work. */
function addonBaseUrl(url: string): string {
  const withoutManifest = url.endsWith("/manifest.json") ? url.slice(0, -"/manifest.json".length) : url;
  return withoutManifest.endsWith("/") ? withoutManifest.slice(0, -1) : withoutManifest;
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(7000),
  /** Listen on this Unix socket instead of PORT (kitshn sets it, K-607). */
  UNIX_SOCKET: optionalString,
  /** Public base URL of this server. Without it, the URL comes from the request (and X-Forwarded-* headers). */
  PUBLIC_URL: z.url().transform(addonBaseUrl).optional(),
  /** Comma-separated subtitle addons, in the same order as in Stremio. The first English subtitle wins. */
  SUBTITLE_ADDONS: z
    .string()
    .default("https://opensubtitles-v3.strem.io")
    .transform((value) => value.split(",").map((url) => url.trim()).filter((url) => url !== ""))
    .pipe(z.array(z.url().transform(addonBaseUrl)).min(1)),
  CACHE_DIR: z.string().default("./cache"),
  /** The oldest translated files are deleted when the cache grows past this size. */
  CACHE_MAX_MB: z.coerce.number().positive().default(500),
  /** Start the translation when Stremio lists subtitles, before the track is selected. */
  PREFETCH: z.stringbool().default(true),
  TRANSLATE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** How long a subtitle request waits for the translation before it gets a partial file. */
  SUBTITLE_WAIT_SECONDS: z.coerce.number().positive().max(240).default(20),

  /** Keyless Google Translate. On by default, so the addon works without any key. */
  GOOGLE_TRANSLATE: z.stringbool().default(true),

  LIBRETRANSLATE_URL: z.url().transform(addonBaseUrl).optional(),
  LIBRETRANSLATE_API_KEY: optionalString,

  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),

  /** Any OpenAI-compatible API: OpenAI, OpenRouter, Gemini, Groq, Ollama, and so on. */
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: z.url().optional(),
  OPENAI_MODEL: optionalString,
});

export const env = EnvSchema.parse(process.env);

if (env.OPENAI_API_KEY && !env.OPENAI_MODEL) throw new Error("OPENAI_MODEL is required when OPENAI_API_KEY is set");
