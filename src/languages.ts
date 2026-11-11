import stremioLanguages from "./stremio-languages.json";

// Stremio labels subtitle tracks with the ISO 639-2 codes in this file (a copy of
// stremio-web src/common/languageNames.json). Refresh it with `bun run update-languages`.
// The addon offers only these codes, so Stremio can always group and auto-select the track.

export type Language = {
  /** ISO 639-2 code as Stremio uses it, for example "heb". */
  code: string;
  /** BCP 47 tag, for example "he". Null for OpenSubtitles-only codes such as "pob" and "spl". */
  bcp47: string | null;
  /** English name for prompts and the configure page. */
  name: string;
  nativeName: string;
};

const englishNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

export function toBcp47(code: string): string | null {
  try {
    return Intl.getCanonicalLocales(code)[0] ?? null;
  } catch {
    return null;
  }
}

export const languages: ReadonlyMap<string, Language> = new Map(
  Object.entries(stremioLanguages).map(([code, nativeName]) => {
    const tag = toBcp47(code);
    const englishName = tag ? englishNames.of(tag) : undefined;
    // No English name means the code is not a real ISO code ("pob", "spl").
    // The Stremio native name ("Português Brazil") then describes it well enough for an LLM.
    return [code, { code, bcp47: englishName ? tag : null, name: englishName ?? nativeName, nativeName }];
  }),
);

export function isEnglish(code: string): boolean {
  return toBcp47(code) === "en";
}
