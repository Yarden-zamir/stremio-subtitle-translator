# Subtitle translator for Stremio

![kitshn](https://kit.yarden-zamir.com/public/badges/Yarden-zamir/stremio-subtitle-translator.svg)

A Stremio subtitle addon. It finds the English subtitle that Stremio would pick for a video and translates it to your language.

**Install:** open https://stremio-subtitles.yarden-zamir.com/configure, choose a language, then select **Install in Stremio**.

## How it works

1. Stremio asks the addon for subtitles. The request contains the video id and the video hash, size and file name.
2. The addon sends the same request to the subtitle addons in `SUBTITLE_ADDONS` (default: OpenSubtitles v3).
3. It takes the first English subtitle, in addon order. Stremio selects that track when English is the preferred language.
4. It returns one track in the target language. The translation starts when Stremio loads the track, or earlier with `PREFETCH=true`.
5. Translated files go to `CACHE_DIR`, so the next load takes no time and costs nothing. When the cache grows past `CACHE_MAX_MB`, the oldest files go first.

If a translation takes longer than `SUBTITLE_WAIT_SECONDS`, the player gets a partial file. Translated cues show in your language. The other cues show the English text with a ⏳ marker. Select the track again later to get the full file.

If part of a translation fails, the player still gets a file. The failed cues show the English text with a ⚠ marker, and a notice at the start says so. Partial files are not cached, so selecting the track again retries. If the whole translation fails, the track shows one cue with the error.

Sources can be SRT or WebVTT. The addon always serves SRT.

## Providers

| Provider | Setting | Speed for a full movie | Notes |
| --- | --- | --- | --- |
| Google Translate | `GOOGLE_TRANSLATE=true` (default) | About 4 seconds | No key. Unofficial endpoint, so it can rate limit or change. |
| Claude | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Some minutes | Best quality. Set `ANTHROPIC_MODEL=claude-haiku-5-5` for low cost. |
| OpenAI-compatible | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | Depends on model | OpenAI, OpenRouter, Gemini, Groq, Ollama and others. |
| LibreTranslate | `LIBRETRANSLATE_URL`, `LIBRETRANSLATE_API_KEY` | Many minutes on CPU | Self-hosted and free. Lower quality for some languages. |

API keys stay on the server. The Stremio install link contains only the language and the provider. The public instance has only Google Translate, so it has no API cost. A key on a public instance lets anyone spend it.

## Run

```sh
bun install
cp .env.example .env   # optional: add keys
bun run dev
```

Open http://localhost:7000/configure. Choose a provider and a language, then select **Install in Stremio**.

With Docker (includes LibreTranslate):

```sh
docker compose -f compose.local.yaml up -d --build
```

Stremio accepts addons over HTTP only on `localhost`. To use the addon on a TV or phone, put the server behind HTTPS and set `PUBLIC_URL`.

## Deploy

[kitshn](https://kit.yarden-zamir.com) deploys each push to `main` from [`compose.yaml`](compose.yaml) to a machine labelled `docker`, at https://stremio-subtitles.yarden-zamir.com. The server listens on the Unix socket in `UNIX_SOCKET`.

The address is public, so `compose.yaml` limits the container. At worst a traffic spike slows the addon down or restarts it. The machine and its other apps keep running.

| Limit | Value |
| --- | --- |
| CPU | 0.5 core |
| Memory, cache included | 384 MB |
| Cache (`/data` tmpfs) | 96 MB, pruned at 80 MB |
| Root file system | Read-only |
| Open files | 4096 |
| Logs | 3 files of 10 MB |
| Remembered subtitle links | 10,000, oldest first out |

## Commands

| Command | Action |
| --- | --- |
| `bun run dev` | Start with reload on change |
| `bun run start` | Start |
| `bun run test` | Run tests |
| `bun run typecheck` | Type check |
| `bun run update-languages` | Refresh the Stremio language list in `src/stremio-languages.json` |

## Limits

- Subtitles inside the video file are not visible to addons. If the player prefers an embedded English track, this addon translates the addon subtitle instead.
- Translation starts at the first cue. If you resume in the middle of a long video with a slow provider, the first partial file can still show English at that point.
- The addon keeps the subtitle source URL in memory. After a restart, open the video again in Stremio. The public instance keeps its cache in memory too, so a restart empties it.
- Many users at once can make Google Translate refuse requests. Those cues then show English with ⚠ until a retry works.

## License

[MIT](LICENSE)
