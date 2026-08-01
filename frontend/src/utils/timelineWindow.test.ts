import { describe, expect, it } from 'vitest';
import { anchoredScrollTop, selectNewestWindow, selectTimelineWindow } from './timelineWindow';

describe('selectTimelineWindow', () => {
  it('keeps short timelines intact', () => {
    expect(selectTimelineWindow([1, 2, 3], 10)).toEqual({
      items: [1, 2, 3],
      hiddenCount: 0,
    });
  });

  it('keeps the newest long-run activity mounted', () => {
    // Models a multi-hour turn with 870 durable events so the regression
    // covers the workload that exposed the bug.
    const timeline = Array.from({ length: 870 }, (_, index) => index + 1);

    const result = selectTimelineWindow(timeline, 160);

    expect(result.hiddenCount).toBe(710);
    expect(result.items).toHaveLength(160);
    expect(result.items[0]).toBe(711);
    expect(result.items.at(-1)).toBe(870);
    expect(timeline).toHaveLength(870);
  });

  it('reveals earlier activity in bounded increments', () => {
    const timeline = Array.from({ length: 500 }, (_, index) => index + 1);

    const result = selectTimelineWindow(timeline, 120, 240);

    expect(result.hiddenCount).toBe(140);
    expect(result.items).toHaveLength(360);
    expect(result.items[0]).toBe(141);
  });

  it('sanitizes invalid limits', () => {
    expect(selectTimelineWindow([1, 2, 3], 0, -20)).toEqual({
      items: [3],
      hiddenCount: 2,
    });
  });

  it('bounds a complete 222-message transcript without discarding state', () => {
    const messages = Array.from({ length: 222 }, (_, index) => ({ id: index + 1 }));

    const result = selectNewestWindow(messages, 80);

    expect(result.hiddenCount).toBe(142);
    expect(result.items).toHaveLength(80);
    expect(result.items[0].id).toBe(143);
    expect(result.items[result.items.length - 1].id).toBe(222);
    expect(messages).toHaveLength(222);
  });

  it('bounds a tool-only turn independently of transcript length', () => {
    const tools = Array.from({ length: 178 }, (_, index) => ({ id: index + 1 }));

    const result = selectNewestWindow(tools, 40);

    expect(result.hiddenCount).toBe(138);
    expect(result.items).toHaveLength(40);
    expect(result.items[0].id).toBe(139);
  });

  it('preserves the visible row when an older page is prepended', () => {
    expect(anchoredScrollTop({ scrollTop: 24, scrollHeight: 1_200 }, 2_050)).toBe(874);
    expect(anchoredScrollTop({ scrollTop: 24, scrollHeight: 1_200 }, 1_000)).toBe(24);
    expect(anchoredScrollTop({ scrollTop: Number.NaN, scrollHeight: Number.NaN }, Number.NaN)).toBe(0);
  });
});
