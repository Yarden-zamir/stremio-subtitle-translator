import { defineApp } from "kitshn";

// kitshn 2 (https://kit.yarden-zamir.com): a public Compose app on a machine labelled "docker".
// Stremio fetches the addon without a login, so the card starts in Everyone.
export default defineApp({
  compose: { runsOn: ["docker"] },
  deploy: [
    { on: "push", branch: "main", name: "prod", address: "stremio-subtitles.yarden-zamir.com", startsIn: "Everyone" },
    { on: "pull_request", name: "pr-{pr}", ephemeral: true },
  ],
});
