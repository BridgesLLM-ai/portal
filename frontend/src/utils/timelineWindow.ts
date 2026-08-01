export interface TimelineWindow<T> {
  items: T[];
  hiddenCount: number;
}

export interface TimelineScrollAnchor {
  scrollTop: number;
  scrollHeight: number;
}

/** Preserve the first visible row when older content is prepended. */
export function anchoredScrollTop(anchor: TimelineScrollAnchor, nextScrollHeight: number): number {
  const previousTop = Number.isFinite(anchor.scrollTop) ? anchor.scrollTop : 0;
  const previousHeight = Number.isFinite(anchor.scrollHeight) ? anchor.scrollHeight : 0;
  const nextHeight = Number.isFinite(nextScrollHeight) ? nextScrollHeight : previousHeight;
  return Math.max(0, previousTop + Math.max(0, nextHeight - previousHeight));
}

/**
 * Keep the newest portion of a collection mounted while preserving the full
 * source in state. Long transcripts and agent turns can contain hundreds of
 * messages, tools, and thought segments; rendering every historical card on
 * every live update eventually overwhelms low-spec browsers. Callers can
 * increase `revealedEarlier` without mutating or discarding the source.
 */
export function selectNewestWindow<T>(
  items: readonly T[],
  baseLimit: number,
  revealedEarlier = 0,
): TimelineWindow<T> {
  const safeBaseLimit = Math.max(1, Math.floor(baseLimit));
  const safeRevealedEarlier = Math.max(0, Math.floor(revealedEarlier));
  const visibleCount = safeBaseLimit + safeRevealedEarlier;
  const hiddenCount = Math.max(0, items.length - visibleCount);

  return {
    items: hiddenCount > 0 ? items.slice(hiddenCount) : Array.from(items),
    hiddenCount,
  };
}

export function selectTimelineWindow<T>(
  items: readonly T[],
  baseLimit: number,
  revealedEarlier = 0,
): TimelineWindow<T> {
  return selectNewestWindow(items, baseLimit, revealedEarlier);
}
