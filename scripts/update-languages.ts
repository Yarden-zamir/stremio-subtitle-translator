// Refresh the Stremio language list that src/languages.ts reads.
const source = "https://raw.githubusercontent.com/Stremio/stremio-web/development/src/common/languageNames.json";
const target = new URL("../src/stremio-languages.json", import.meta.url);

const response = await fetch(source);
if (!response.ok) throw new Error(`GET ${source} returned ${response.status}`);
const names: unknown = await response.json();
if (typeof names !== "object" || names === null || Object.keys(names).length === 0) {
  throw new Error(`Unexpected content in ${source}`);
}
await Bun.write(target, JSON.stringify(names, null, 4) + "\n");
console.log(`Wrote ${Object.keys(names).length} languages to ${target.pathname}`);
