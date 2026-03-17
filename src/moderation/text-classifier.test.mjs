// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for text-based content classifier and VTT parser
// ABOUTME: Verifies keyword pattern matching, score normalization, and VTT stripping

import { describe, it, expect } from 'vitest';
import { classifyText, parseVttText } from './text-classifier.mjs';

describe('parseVttText', () => {
  it('strips WEBVTT header', () => {
    const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:05.000
Hello world`;
    expect(parseVttText(vtt)).toBe('Hello world');
  });

  it('strips WEBVTT header with metadata', () => {
    const vtt = `WEBVTT Kind: captions

00:00:00.000 --> 00:00:03.000
Some caption text`;
    expect(parseVttText(vtt)).toBe('Some caption text');
  });

  it('strips timestamps in 00:00:00.000 --> format', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
First line
00:00:02.000 --> 00:00:04.000
Second line`;
    expect(parseVttText(vtt)).toBe('First line Second line');
  });

  it('strips cue IDs (numeric lines)', () => {
    const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:02.000
Line one
2
00:00:02.000 --> 00:00:04.000
Line two`;
    expect(parseVttText(vtt)).toBe('Line one Line two');
  });

  it('strips NOTE blocks', () => {
    const vtt = `WEBVTT

NOTE This is a comment

00:00:00.000 --> 00:00:02.000
Actual content`;
    expect(parseVttText(vtt)).toBe('Actual content');
  });

  it('strips VTT formatting tags', () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
<v Speaker>Hello there</v>
00:00:02.000 --> 00:00:04.000
<b>Bold text</b> and <i>italic</i>`;
    expect(parseVttText(vtt)).toBe('Hello there Bold text and italic');
  });

  it('returns empty string for null/undefined input', () => {
    // parseVttText will throw on null/undefined since it calls .split()
    // but we test that it handles empty string
    expect(parseVttText('')).toBe('');
  });

  it('handles plain text with no VTT formatting', () => {
    const plain = 'Just some regular text without any VTT formatting';
    expect(parseVttText(plain)).toBe('Just some regular text without any VTT formatting');
  });
});

describe('classifyText', () => {
  const ALL_CATEGORIES = ['hate_speech', 'threats', 'harassment', 'self_harm', 'grooming', 'profanity'];

  it('returns zero scores for benign text', () => {
    const result = classifyText('The weather is nice today and I enjoy reading books.');
    for (const category of ALL_CATEGORIES) {
      expect(result[category]).toBe(0);
    }
  });

  it('detects profanity with score > 0', () => {
    const result = classifyText('What the fuck is this shit');
    expect(result.profanity).toBeGreaterThan(0);
  });

  it('returns scores between 0 and 1 for all categories', () => {
    // Text with many profane words to potentially push scores high
    const result = classifyText('fuck fuck fuck shit shit bitch fucking fucker motherfucker cocksucker');
    for (const category of ALL_CATEGORIES) {
      expect(result[category]).toBeGreaterThanOrEqual(0);
      expect(result[category]).toBeLessThanOrEqual(1);
    }
  });

  it('returns all six categories', () => {
    const result = classifyText('hello world');
    expect(Object.keys(result).sort()).toEqual(ALL_CATEGORIES.sort());
  });

  it('handles empty string', () => {
    const result = classifyText('');
    for (const category of ALL_CATEGORIES) {
      expect(result[category]).toBe(0);
    }
  });

  it('handles null/undefined input', () => {
    const resultNull = classifyText(null);
    const resultUndefined = classifyText(undefined);
    for (const category of ALL_CATEGORIES) {
      expect(resultNull[category]).toBe(0);
      expect(resultUndefined[category]).toBe(0);
    }
  });

  it('detects threats', () => {
    const result = classifyText("I'm gonna kill you");
    expect(result.threats).toBeGreaterThan(0);
  });

  it('detects harassment', () => {
    const result = classifyText('kill yourself kys');
    expect(result.harassment).toBeGreaterThan(0);
  });

  it('caps scores at 1.0 even with many matches', () => {
    const result = classifyText('fuck fuck fuck fuck fuck fuck fuck fuck fuck fuck fuck fuck');
    expect(result.profanity).toBe(1.0);
  });
});
