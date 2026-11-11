import { expect, test } from "bun:test";
import { formatSrt, parseSubtitle } from "./srt.ts";

const srt = "﻿1\r\n00:01:51,822 --> 00:01:53,790\r\nMr. Dufresne, describe...\r\n\r\n\r\n2\r\n00:01:53,991 --> 00:01:58,325\r\n<i>the confrontation</i>\r\nyou had\r\n";

test("SRT keeps timings, multi-line text and tags", () => {
  expect(parseSubtitle(srt)).toEqual([
    { timing: "00:01:51,822 --> 00:01:53,790", text: "Mr. Dufresne, describe..." },
    { timing: "00:01:53,991 --> 00:01:58,325", text: "<i>the confrontation</i>\nyou had" },
  ]);
});

test("WebVTT becomes SRT timings without cue ids, settings or notes", () => {
  const vtt = "WEBVTT\n\nNOTE made by hand\n\nintro\n00:01.500 --> 00:04.000 align:start\nHello\n\n01:02:03.004 --> 01:02:05.000\nBye\n";
  expect(parseSubtitle(vtt)).toEqual([
    { timing: "00:00:01,500 --> 00:00:04,000", text: "Hello" },
    { timing: "01:02:03,004 --> 01:02:05,000", text: "Bye" },
  ]);
});

test("format and parse round trip", () => {
  const cues = parseSubtitle(srt);
  expect(parseSubtitle(formatSrt(cues))).toEqual(cues);
});

test("rejects files without valid cues", () => {
  expect(() => parseSubtitle("<html>error</html>")).toThrow();
  expect(() => parseSubtitle("1\nsoon --> later\nHi")).toThrow();
});
