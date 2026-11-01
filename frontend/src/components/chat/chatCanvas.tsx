import React from 'react';

/**
 * The chat working canvas. Transcript rows are `max-w-[88rem]` so widgets,
 * tables, code and tool cards get room, while `.chat-markdown` prose keeps an
 * 80ch measure (index.css). The `chat-canvas` class scopes the focus-visible
 * outlines and the reduced-motion rule to Agent Chat and Project chat alike.
 *
 * ChatCanvasColumn is the column tool cards use. Anything rendered beside
 * them (a widget card) must sit in it too, or it spans the full row.
 */
export function ChatCanvasColumn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center px-4 py-1" data-chat-canvas-column>
      <div className="w-full min-w-0 max-w-[80rem]">{children}</div>
    </div>
  );
}
