// Unit tests for frameTime.ts (frame index / file name → seconds).

import { describe, expect, test } from "bun:test";
import { frameFileTimeS, frameTimeS } from "./frameTime";

describe("frame timestamps (fps = 0.5)", () => {
  test("frame i is at i × 2 seconds, never the raw index", () => {
    expect(frameTimeS(0)).toBe(0);
    expect(frameTimeS(1)).toBe(2);
    expect(frameTimeS(50)).toBe(100);
  });

  test("time comes from ffmpeg's file name", () => {
    expect(frameFileTimeS("00000.jpg")).toBe(0);
    expect(frameFileTimeS("00050.jpg")).toBe(100);
    expect(frameFileTimeS("00149.jpg")).toBe(298); // last frame of a 300s video
  });
});
