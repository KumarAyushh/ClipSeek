// Unit tests for speechQuery.ts (queries that ask whether someone is speaking).

import { describe, expect, test } from "bun:test";
import { asksOnlyForSpeech } from "./speechQuery";

describe("asksOnlyForSpeech", () => {
  test("queries entirely about talking", () => {
    expect(asksOnlyForSpeech("person talking")).toBe(true);
    expect(asksOnlyForSpeech("people talking")).toBe(true);
    expect(asksOnlyForSpeech("talking")).toBe(true);
    expect(asksOnlyForSpeech("A man is speaking")).toBe(true);
  });

  test("a query that names a topic stays a normal search", () => {
    expect(asksOnlyForSpeech("man talking about football")).toBe(false);
    expect(asksOnlyForSpeech("a speech on climate")).toBe(false);
  });

  test("a query with no speech word stays a normal search", () => {
    expect(asksOnlyForSpeech("dog barking")).toBe(false);
    expect(asksOnlyForSpeech("the person")).toBe(false);
  });

  test("empty or symbols only → false", () => {
    expect(asksOnlyForSpeech("")).toBe(false);
    expect(asksOnlyForSpeech("???")).toBe(false);
  });
});
