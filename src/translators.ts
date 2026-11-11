import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { z } from "zod";
import { env } from "./env.ts";
import { languages, type Language } from "./languages.ts";

export const providerIds = ["google", "libretranslate", "anthropic", "openai"] as const;
export type ProviderId = (typeof providerIds)[number];

export type Translator = {
  id: ProviderId;
  label: string;
  /** Changes when the output changes (provider and model). Part of the cache key. */
  cacheId: string;
  /** Number of subtitle cues sent in one request. */
  batchSize: number;
  supportedLanguages(): Promise<Language[]>;
  /** Returns one translated string per input string, in the same order. */
  translate(lines: string[], target: Language): Promise<string[]>;
};

const TranslationsSchema = z.object({ translations: z.array(z.string()) });

function llmInstructions(target: Language): string {
  return [
    `You translate movie and TV subtitles from English to ${target.name}.`,
    "The input is a JSON array of subtitle cues in playback order.",
    'Reply with JSON of the form {"translations": [...]} that has exactly one translated string per input cue, in the same order.',
    "Never merge, split, drop or reorder cues. Keep line breaks inside a cue and keep formatting tags such as <i>.",
    "Write natural spoken dialogue. Keep names. Use the surrounding cues for context.",
  ].join("\n");
}

function llmLanguages(): Promise<Language[]> {
  return Promise.resolve([...languages.values()]);
}

function anthropicTranslator(apiKey: string): Translator {
  const client = new Anthropic({ apiKey });
  return {
    id: "anthropic",
    label: `Anthropic (${env.ANTHROPIC_MODEL})`,
    cacheId: `anthropic:${env.ANTHROPIC_MODEL}`,
    batchSize: 100,
    supportedLanguages: llmLanguages,
    async translate(lines, target) {
      // `effort` and `fallbacks: "default"` are valid for Claude 5-family models.
      // Revisit both if ANTHROPIC_MODEL points to an older model and requests return 400.
      const response = await client.beta.messages.parse({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: betaZodOutputFormat(TranslationsSchema) },
        system: llmInstructions(target),
        messages: [{ role: "user", content: JSON.stringify(lines) }],
      });
      if (response.stop_reason !== "end_turn") throw new Error(`Claude stopped with ${response.stop_reason}`);
      if (!response.parsed_output) throw new Error("Claude returned no parsable translation");
      return response.parsed_output.translations;
    },
  };
}

function openAiTranslator(apiKey: string, model: string): Translator {
  const client = new OpenAI({ apiKey, baseURL: env.OPENAI_BASE_URL });
  const host = env.OPENAI_BASE_URL ? new URL(env.OPENAI_BASE_URL).host : "api.openai.com";
  return {
    id: "openai",
    label: `OpenAI-compatible (${model} on ${host})`,
    cacheId: `openai:${host}:${model}`,
    batchSize: 100,
    supportedLanguages: llmLanguages,
    async translate(lines, target) {
      // json_object instead of json_schema, because more OpenAI-compatible servers support it.
      const response = await client.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: llmInstructions(target) },
          { role: "user", content: JSON.stringify(lines) },
        ],
      });
      const content = response.choices[0]?.message.content;
      if (!content) throw new Error(`${model} returned no content`);
      return TranslationsSchema.parse(JSON.parse(content)).translations;
    },
  };
}

/**
 * Machine translation engines keep line breaks in the wrong place inside a cue.
 * Send each cue as one line, then split it again at the space nearest the middle.
 */
async function translateAsOneLine(lines: string[], translate: (flat: string[]) => Promise<string[]>): Promise<string[]> {
  const result = await translate(lines.map((line) => line.split("\n").map((part) => part.trim()).join(" ")));
  return result.map((text, i) => (lines[i]?.includes("\n") ? splitInTwo(text) : text));
}

function splitInTwo(text: string): string {
  const middle = text.length / 2;
  let best = -1;
  for (let i = text.indexOf(" "); i !== -1; i = text.indexOf(" ", i + 1)) {
    if (best === -1 || Math.abs(i - middle) < Math.abs(best - middle)) best = i;
  }
  return best === -1 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

function googleTranslator(): Translator {
  // The keyless endpoint that the Google Translate web widget uses. It is not an official API:
  // revisit if it starts to return 429 or changes shape (then use the paid Cloud Translation API).
  const endpoint = "https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&format=text";
  // One q returns a string, several return an array.
  const ResponseSchema = z.union([z.string().transform((text) => [text]), z.array(z.string())]);
  return {
    id: "google",
    label: "Google Translate",
    cacheId: "google:gtx",
    batchSize: 100,
    async supportedLanguages() {
      // Google supports almost every language. Codes without a BCP 47 tag ("pob", "spl") are not real codes.
      return [...languages.values()].filter((language) => language.bcp47 !== null && language.bcp47 !== "en");
    },
    async translate(lines, target) {
      if (!target.bcp47) throw new Error(`Google Translate has no code for ${target.name}`);
      const targetCode = target.bcp47;
      return translateAsOneLine(lines, async (flat) => {
        const body = new URLSearchParams(flat.map((line): [string, string] => ["q", line]));
        const response = await fetch(`${endpoint}&tl=${encodeURIComponent(targetCode)}`, { method: "POST", body });
        if (!response.ok) throw new Error(`Google Translate returned ${response.status}: ${await response.text()}`);
        return ResponseSchema.parse(await response.json());
      });
    },
  };
}

const LibreLanguagesSchema =z.array(z.object({ code: z.string(), name: z.string(), targets: z.array(z.string()) }));

function libreTranslator(baseUrl: string, apiKey: string | undefined): Translator {
  let targetCodes: Promise<Map<string, string>> | undefined;

  /** Maps Stremio codes to LibreTranslate codes. Fetched once; restart the server after you add LibreTranslate models. */
  function loadTargetCodes(): Promise<Map<string, string>> {
    targetCodes ??= (async () => {
      const response = await fetch(`${baseUrl}/languages`);
      if (!response.ok) throw new Error(`LibreTranslate /languages returned ${response.status}`);
      const english = LibreLanguagesSchema.parse(await response.json()).find((language) => language.code === "en");
      if (!english) throw new Error("LibreTranslate has no English source model");
      const map = new Map<string, string>();
      for (const language of languages.values()) {
        const tag = language.bcp47;
        if (!tag || tag === "en") continue;
        // LibreTranslate uses region or script variants for some languages, for example "zh-Hans".
        const match = english.targets.find((code) => code === tag) ?? english.targets.find((code) => code.startsWith(`${tag}-`));
        if (match) map.set(language.code, match);
      }
      return map;
    })().catch((error: unknown) => {
      targetCodes = undefined;
      throw error;
    });
    return targetCodes;
  }

  return {
    id: "libretranslate",
    label: "LibreTranslate",
    cacheId: `libretranslate:${baseUrl}`,
    // Small batches, because LibreTranslate on CPU is slow and partial files show finished batches only.
    batchSize: 20,
    async supportedLanguages() {
      const map = await loadTargetCodes();
      return [...languages.values()].filter((language) => map.has(language.code));
    },
    async translate(lines, target) {
      const code = (await loadTargetCodes()).get(target.code);
      if (!code) throw new Error(`LibreTranslate cannot translate English to ${target.name}`);
      return translateAsOneLine(lines, async (flat) => {
        const response = await fetch(`${baseUrl}/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: flat, source: "en", target: code, format: "text", api_key: apiKey }),
        });
        if (!response.ok) throw new Error(`LibreTranslate returned ${response.status}: ${await response.text()}`);
        return z.object({ translatedText: z.array(z.string()) }).parse(await response.json()).translatedText;
      });
    },
  };
}

function configuredTranslators(): Map<ProviderId, Translator> {
  const list: Translator[] = [];
  if (env.GOOGLE_TRANSLATE) list.push(googleTranslator());
  if (env.LIBRETRANSLATE_URL) list.push(libreTranslator(env.LIBRETRANSLATE_URL, env.LIBRETRANSLATE_API_KEY));
  if (env.ANTHROPIC_API_KEY) list.push(anthropicTranslator(env.ANTHROPIC_API_KEY));
  if (env.OPENAI_API_KEY && env.OPENAI_MODEL) list.push(openAiTranslator(env.OPENAI_API_KEY, env.OPENAI_MODEL));
  if (list.length === 0) {
    throw new Error("No translation provider configured. Set GOOGLE_TRANSLATE=true, LIBRETRANSLATE_URL, ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  }
  return new Map(list.map((translator) => [translator.id, translator]));
}

export const translators = configuredTranslators();
