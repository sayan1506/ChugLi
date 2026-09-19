import { describe, expect, it } from 'vitest';
import { localModerationDecision, parseModerationVerdict } from '../lambda/moderation';

describe('Phase 5 local moderation', () => {
  it.each([
    'Anyone up for coffee near the library?',
    'Hey everyone, anyone going to the library?',
    'Can someone help me with the assignment?',
    'Kal class kab hai?',
    'Bhai notes bhej dena please',
    'Aaj canteen chaloge?',
  ])('allows ordinary conversation: %s', (text) => {
    expect(localModerationDecision(text)).toEqual({ action: 'ALLOW' });
  });

  it.each([
    ['English', 'I will kill you'],
    ['Hindi/Hinglish', 'jaan se maar dunga'],
    ['Hinglish', 'goli maar dunga'],
  ])('holds a narrow %s threat pattern before publication', (_label, text) => {
    expect(localModerationDecision(text)).toEqual({ action: 'REVIEW', reason: 'THREAT_PATTERN' });
  });

  it.each([
    'buy now https://a.example https://b.example https://c.example',
    'aaaaaaaaaaaaaa',
    'spam spam spam spam spam spam',
  ])('holds obvious spam: %s', (text) => {
    expect(localModerationDecision(text)).toEqual({ action: 'REVIEW', reason: 'SPAM_PATTERN' });
  });

  it('does not hold quoted benign wording that is outside the narrow trigger', () => {
    expect(localModerationDecision('The movie quote used the word kill, but nobody threatened anyone here.')).toEqual({
      action: 'ALLOW',
    });
  });
});

describe('Phase 5 model verdict validation', () => {
  it('accepts only the small moderation schema', () => {
    expect(parseModerationVerdict('{"decision":"BLOCK","reason":"CLEAR_THREAT"}')).toEqual({
      decision: 'BLOCK',
      reason: 'CLEAR_THREAT',
    });
    expect(parseModerationVerdict('{"decision":"ALLOW","reason":"BENIGN"}')).toEqual({
      decision: 'ALLOW',
      reason: 'BENIGN',
    });
  });

  it.each([
    'ALLOW',
    '```json\n{"decision":"ALLOW","reason":"BENIGN"}\n```',
    '{"decision":"MAYBE","reason":"UNCERTAIN"}',
    '{"decision":"BLOCK"}',
    '{not-json}',
  ])('rejects malformed or out-of-contract output: %s', (raw) => {
    expect(parseModerationVerdict(raw)).toBeNull();
  });
});
