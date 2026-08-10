import { describe, expect, it } from 'vitest';
import {
  parseAskQuestionPayload,
  formatAskQuestionAnswer,
  isUnansweredAskQuestionResult,
  __askQuestionCardTest,
} from './AskQuestionCard';

describe('parseAskQuestionPayload', () => {
  const valid = {
    questions: [
      {
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'Option A', description: 'first' },
          { label: 'Option B' },
        ],
      },
    ],
  };

  it('parses a well-formed payload from an object', () => {
    const parsed = parseAskQuestionPayload(valid);
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0].question).toBe('Which approach?');
    expect(parsed?.questions[0].options.map((o) => o.label)).toEqual(['Option A', 'Option B']);
    expect(parsed?.questions[0].options[0].description).toBe('first');
  });

  it('parses the same payload delivered as a JSON string', () => {
    expect(parseAskQuestionPayload(JSON.stringify(valid))).toEqual(parseAskQuestionPayload(valid));
  });

  it('returns null for malformed input so the caller falls back to a plain pill', () => {
    expect(parseAskQuestionPayload('not json')).toBeNull();
    expect(parseAskQuestionPayload(null)).toBeNull();
    expect(parseAskQuestionPayload(42)).toBeNull();
    expect(parseAskQuestionPayload({})).toBeNull();
    expect(parseAskQuestionPayload({ questions: [] })).toBeNull();
    expect(parseAskQuestionPayload({ questions: [{ options: [] }] })).toBeNull();
  });

  it('bounds question and option counts', () => {
    const many = {
      questions: Array.from({ length: 20 }, (_, i) => ({
        question: `Q${i}`,
        options: Array.from({ length: 40 }, (_, j) => ({ label: `O${j}` })),
      })),
    };
    const parsed = parseAskQuestionPayload(many);
    expect(parsed?.questions.length).toBe(__askQuestionCardTest.MAX_QUESTIONS);
    expect(parsed?.questions[0].options.length).toBe(__askQuestionCardTest.MAX_OPTIONS);
  });

  it('coerces and bounds hostile field types without throwing', () => {
    const hostile = {
      questions: [
        {
          question: 'x'.repeat(5000),
          header: 'h'.repeat(500),
          options: [
            { label: 'y'.repeat(5000) },
            { label: 42 },
            { label: '' },
            null,
            'string-option',
          ],
        },
      ],
    };
    const parsed = parseAskQuestionPayload(hostile);
    expect(parsed?.questions[0].question.length).toBeLessThanOrEqual(500);
    expect(parsed?.questions[0].header?.length).toBeLessThanOrEqual(24);
    // Only the one valid string label survives.
    expect(parsed?.questions[0].options).toHaveLength(1);
    expect(parsed?.questions[0].options[0].label.length).toBeLessThanOrEqual(200);
  });

  it('drops questions with no usable text but keeps valid siblings', () => {
    const mixed = {
      questions: [
        { question: '   ', options: [{ label: 'A' }] },
        { question: 'Real question', options: [{ label: 'B' }] },
      ],
    };
    const parsed = parseAskQuestionPayload(mixed);
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0].question).toBe('Real question');
  });

  it('keeps a question that has no options so free text is still answerable', () => {
    const parsed = parseAskQuestionPayload({ questions: [{ question: 'Open ended?' }] });
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0].options).toEqual([]);
  });
});

describe('formatAskQuestionAnswer', () => {
  const payload = {
    questions: [
      { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Second?', options: [{ label: 'C' }] },
    ],
  };

  it('joins selections and free text per question', () => {
    const text = formatAskQuestionAnswer(payload, { 0: ['A', 'B'] }, { 1: 'typed answer' });
    expect(text).toBe('First?\nA, B\n\nSecond?\ntyped answer');
  });

  it('combines a selection with free text on the same question', () => {
    expect(formatAskQuestionAnswer(payload, { 0: ['A'] }, { 0: 'and more' }))
      .toBe('First?\nA, and more');
  });

  it('omits unanswered questions entirely', () => {
    expect(formatAskQuestionAnswer(payload, { 1: ['C'] }, {})).toBe('Second?\nC');
    expect(formatAskQuestionAnswer(payload, {}, {})).toBe('');
  });

  it('ignores whitespace-only free text', () => {
    expect(formatAskQuestionAnswer(payload, {}, { 0: '   ' })).toBe('');
  });
});

describe('isUnansweredAskQuestionResult', () => {
  it('recognizes Claude native questions that settled without a human answer', () => {
    expect(isUnansweredAskQuestionResult('The user did not answer the questions.')).toBe(true);
    expect(isUnansweredAskQuestionResult('  The user did not answer the question  ')).toBe(true);
  });

  it('does not relabel a real answer', () => {
    expect(isUnansweredAskQuestionResult('Use the durable fix.')).toBe(false);
    expect(isUnansweredAskQuestionResult(undefined)).toBe(false);
  });
});
