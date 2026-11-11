export type Cue = { timing: string; text: string };

/**
 * Parses SRT and WebVTT. Cue numbers, WebVTT cue ids, cue settings and NOTE/STYLE blocks are dropped.
 * Timings are written in SRT form, so `formatSrt` always produces valid SRT.
 */
export function parseSubtitle(input: string): Cue[] {
  const text = input.startsWith("﻿") ? input.slice(1) : input;
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const cues: Cue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.includes("-->")) continue;
    const textLines: string[] = [];
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") textLines.push(lines[++i]!.trimEnd());
    cues.push({ timing: srtTiming(line), text: textLines.join("\n") });
  }
  if (cues.length === 0) throw new Error("No subtitle cues found");
  return cues;
}

/** "00:01.500 --> 00:04.000 align:start" (WebVTT) or "00:00:01,500 --> 00:00:04,000" (SRT) to SRT form. */
function srtTiming(line: string): string {
  const [start, end] = line.split("-->").map((side) => srtTime(side.trim().split(" ")[0] ?? ""));
  return `${start} --> ${end}`;
}

function srtTime(token: string): string {
  const [clock = "", millis = ""] = token.replace(".", ",").split(",");
  const parts = clock.split(":");
  const [hours, minutes, seconds] = parts.length === 2 ? ["00", ...parts] : parts;
  const isNumber = (value: string | undefined, length: number) =>
    value !== undefined && value.length >= length && [...value].every((c) => c >= "0" && c <= "9");
  if (parts.length > 3 || !isNumber(hours, 1) || !isNumber(minutes, 2) || !isNumber(seconds, 2) || !isNumber(millis, 3)) {
    throw new Error(`Invalid subtitle time "${token}"`);
  }
  return `${hours!.padStart(2, "0")}:${minutes}:${seconds},${millis}`;
}

export function formatSrt(cues: readonly Cue[]): string {
  return cues.map((cue, i) => `${i + 1}\n${cue.timing}\n${cue.text}`).join("\n\n") + "\n";
}

/** A one-cue file, so the player shows a message instead of an empty track. */
export function messageSrt(text: string): string {
  return formatSrt([{ timing: "00:00:00,000 --> 00:00:10,000", text }]);
}
