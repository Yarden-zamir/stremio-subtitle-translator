import { z } from "zod";
import { env } from "./env.ts";
import { isEnglish } from "./languages.ts";

const ManifestSchema = z.object({
  name: z.string(),
  resources: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  types: z.array(z.string()),
  idPrefixes: z.array(z.string()).optional(),
});

const SubtitlesSchema = z.object({
  subtitles: z.array(z.object({ id: z.string(), url: z.url(), lang: z.string(), label: z.string().optional() })),
});
export type UpstreamSubtitle = z.infer<typeof SubtitlesSchema>["subtitles"][number];

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response.json();
}

/** Reads the upstream manifests once at startup. This addon serves the union of their types and id prefixes. */
async function loadUpstreamManifests() {
  const manifests = await Promise.all(
    env.SUBTITLE_ADDONS.map(async (url) => ManifestSchema.parse(await getJson(`${url}/manifest.json`))),
  );
  for (const [i, manifest] of manifests.entries()) {
    const hasSubtitles = manifest.resources.some((r) => (typeof r === "string" ? r : r.name) === "subtitles");
    if (!hasSubtitles) throw new Error(`${env.SUBTITLE_ADDONS[i]} ("${manifest.name}") does not serve subtitles`);
  }
  // An upstream without idPrefixes accepts every id, so this addon must too.
  const acceptsAnyId = manifests.some((manifest) => !manifest.idPrefixes);
  return {
    types: [...new Set(manifests.flatMap((manifest) => manifest.types))],
    idPrefixes: acceptsAnyId ? undefined : [...new Set(manifests.flatMap((manifest) => manifest.idPrefixes ?? []))],
  };
}

export const upstreamScope = await loadUpstreamManifests();

/**
 * Asks each upstream addon with the same request that Stremio sends (type, id, and the extra
 * segment with videoHash, videoSize and filename). Returns the first English subtitle, in addon order.
 * That is the track Stremio selects when English is the preferred subtitle language.
 */
export async function findEnglishSubtitle(type: string, id: string, extra: string | undefined): Promise<UpstreamSubtitle | undefined> {
  const path = `/subtitles/${type}/${id}${extra ? `/${extra}` : ""}.json`;
  const results = await Promise.all(
    env.SUBTITLE_ADDONS.map(async (url) => {
      try {
        return SubtitlesSchema.parse(await getJson(url + path)).subtitles;
      } catch (error) {
        // One unreachable addon must not hide the subtitles of the others.
        console.error(`Subtitle addon ${url} failed:`, error);
        return [];
      }
    }),
  );
  return results.flat().find((subtitle) => isEnglish(subtitle.lang));
}
