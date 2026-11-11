import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import packageJson from "../package.json";
import { env } from "./env.ts";
import { cachedFile, getSubtitle, jobKey, startJob } from "./jobs.ts";
import { languages, type Language } from "./languages.ts";
import { messageSrt } from "./srt.ts";
import { providerIds, translators, type Translator } from "./translators.ts";
import { findEnglishSubtitle, upstreamScope } from "./upstream.ts";

const configurePage = Bun.file(new URL("./configure.html", import.meta.url));

/** Per-install settings. Stremio keeps them in the addon URL as base64url JSON. */
const UserConfigSchema = z.object({
  lang: z.string().refine((code) => languages.has(code), "Unknown language code"),
  provider: z.enum(providerIds).refine((id) => translators.has(id), "Provider is not configured on this server"),
});

type Install = { translator: Translator; target: Language };

function parseInstall(segment: string): Install | undefined {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const config = UserConfigSchema.safeParse(json);
  if (!config.success) return undefined;
  return { translator: translators.get(config.data.provider)!, target: languages.get(config.data.lang)! };
}

/** Subtitle URLs handed to Stremio point here. Restarting the server forgets them, but cached files stay valid. */
const pendingSources = new Map<string, { translator: Translator; target: Language; sourceUrl: string }>();
/** Keeps memory bounded on a public server. The oldest links expire first. */
const MAX_PENDING_SOURCES = 10_000;

function rememberSource(key: string, source: { translator: Translator; target: Language; sourceUrl: string }) {
  pendingSources.delete(key);
  pendingSources.set(key, source);
  if (pendingSources.size > MAX_PENDING_SOURCES) pendingSources.delete(pendingSources.keys().next().value!);
}

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders });
}

function notFound(message = "Not found"): Response {
  return json({ error: message }, 404);
}

function publicBaseUrl(request: Request): string {
  if (env.PUBLIC_URL) return env.PUBLIC_URL;
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  return `${proto}://${host}`;
}

function manifest(install: Install | undefined) {
  return {
    id: "community.subtitle-translator",
    version: packageJson.version,
    name: install ? `Translated subtitles: ${install.target.name}` : "Translated subtitles",
    description: install
      ? `Translates the English subtitle that Stremio would pick to ${install.target.name} with ${install.translator.label}.`
      : "Translates the English subtitle that Stremio would pick to your language.",
    resources: ["subtitles"],
    types: upstreamScope.types,
    ...(upstreamScope.idPrefixes ? { idPrefixes: upstreamScope.idPrefixes } : {}),
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: install === undefined },
  };
}

async function subtitles(request: Request, install: Install, rest: string[]): Promise<Response> {
  // Stremio sends /subtitles/{type}/{id}.json or /subtitles/{type}/{id}/{extra}.json.
  const [type, idOrFile, extraFile] = rest;
  if (!type || !idOrFile || rest.length > 3) return notFound();
  const last = extraFile ?? idOrFile;
  if (!last.endsWith(".json")) return notFound();
  const id = extraFile ? idOrFile : idOrFile.slice(0, -".json".length);
  const extra = extraFile?.slice(0, -".json".length);

  const english = await findEnglishSubtitle(type, id, extra);
  if (!english) return json({ subtitles: [] });

  const { translator, target } = install;
  const key = jobKey(translator, target, english.url);
  rememberSource(key, { translator, target, sourceUrl: english.url });
  if (env.PREFETCH && !(await cachedFile(key).exists())) startJob(translator, target, english.url);
  return json({
    subtitles: [
      {
        id: `translated-${key}`,
        url: `${publicBaseUrl(request)}/translated/${key}.srt`,
        lang: target.code,
        label: [`${target.name} from English`, english.label, translator.label].filter(Boolean).join(" · "),
      },
    ],
  });
}

async function translatedFile(file: string): Promise<Response> {
  if (!file.endsWith(".srt")) return notFound();
  const key = file.slice(0, -".srt".length);
  const headers = { ...corsHeaders, "Content-Type": "application/x-subrip; charset=utf-8" };

  const cached = cachedFile(key);
  if (await cached.exists()) return new Response(cached, { headers });

  const source = pendingSources.get(key);
  if (!source) {
    // Happens after a server restart. The player shows a file but not an HTTP error.
    return new Response(messageSrt("⚠ Subtitle expired. Open the video again in Stremio."), { headers: { ...headers, "Cache-Control": "no-store" } });
  }
  try {
    const result = await getSubtitle(source.translator, source.target, source.sourceUrl);
    return new Response(result.srt, { headers: { ...headers, ...(result.complete ? {} : { "Cache-Control": "no-store" }) } });
  } catch (error) {
    // The player shows a subtitle file but not an HTTP error, so send the message as a cue.
    const message = error instanceof Error ? error.message : String(error);
    return new Response(messageSrt(`⚠ Subtitle translation failed: ${message}`), { headers: { ...headers, "Cache-Control": "no-store" } });
  }
}

async function options(): Promise<Response> {
  const providers = await Promise.all(
    [...translators.values()].map(async (translator) => {
      try {
        const supported = await translator.supportedLanguages();
        return { id: translator.id, label: translator.label, languages: supported };
      } catch (error) {
        return { id: translator.id, label: translator.label, languages: [], error: String(error) };
      }
    }),
  );
  return json({ providers });
}

async function route(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  // Raw (still encoded) segments, so the extra segment goes to the upstream addons unchanged.
  const [first, second, ...rest] = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  if (first === undefined) return Response.redirect("/configure", 302);
  if (first === "configure" && second === undefined) return new Response(configurePage);
  if (first === "manifest.json" && second === undefined) return json(manifest(undefined));
  if (first === "api" && second === "options") return options();
  if (first === "translated" && second !== undefined && rest.length === 0) return translatedFile(second);

  const install = parseInstall(first);
  if (!install) return notFound("Invalid addon configuration. Open /configure to create a new install link.");
  if (second === "configure" && rest.length === 0) return new Response(configurePage);
  if (second === "manifest.json" && rest.length === 0) return json(manifest(install));
  if (second === "subtitles") return subtitles(request, install, rest);
  return notFound();
}

// Bun closes an idle connection after 10 seconds. A subtitle response waits up to SUBTITLE_WAIT_SECONDS
// (max 240), so the timeout must be longer.
const idleTimeout = 255;
if (env.UNIX_SOCKET) {
  // A socket file from the previous container (after a restart) blocks the bind. Docker Desktop bind
  // mounts on macOS answer EFAULT here, so a failed cleanup only warns: a real stale socket still fails the bind.
  await rm(env.UNIX_SOCKET, { force: true }).catch((error) => console.warn(`Could not remove ${env.UNIX_SOCKET}:`, error));
  // Bun 1.4.4 honors idleTimeout on a Unix socket, but its types allow it only for TCP. The cast covers
  // that gap. Revisit when @types/bun accepts it, or if long subtitle requests drop after 10 seconds.
  Bun.serve({ unix: env.UNIX_SOCKET, idleTimeout, fetch: route } as unknown as Bun.Serve.Options<undefined>);
  // The kitshn tunnel runs as another user and must be able to connect.
  await chmod(env.UNIX_SOCKET, 0o666);
  console.log(`Subtitle translator on unix:${env.UNIX_SOCKET}`);
} else {
  const server = Bun.serve({ port: env.PORT, idleTimeout, fetch: route });
  console.log(`Subtitle translator on ${server.url}configure`);
}
console.log(`Providers: ${[...translators.values()].map((t) => t.label).join(", ")}`);
console.log(`Subtitle addons: ${env.SUBTITLE_ADDONS.join(", ")}`);
