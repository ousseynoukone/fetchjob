import React from 'react';

export interface InlineLinkSegment {
  text: string;
  url?: string;
}

const INLINE_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

// Parses the `[mot](url)` syntax that LinkableTextInput writes when a word
// is selected and turned into a link — the link lives on the word itself
// instead of being appended as a separate URL.
export function parseInlineLinks(text: string): InlineLinkSegment[] {
  if (!text) return [];
  const segments: InlineLinkSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_LINK_REGEX.lastIndex = 0;
  while ((match = INLINE_LINK_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index) });
    segments.push({ text: match[1], url: match[2] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
  return segments;
}

export function renderInlineLinks(text: string, linkClassName = 'underline'): React.ReactNode {
  if (!text) return null;
  const segments = parseInlineLinks(text);
  return segments.map((seg, i) =>
    seg.url ? (
      <a
        key={i}
        href={seg.url}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClassName}
        onClick={(e) => e.stopPropagation()}
      >
        {seg.text}
      </a>
    ) : (
      <React.Fragment key={i}>{seg.text}</React.Fragment>
    ),
  );
}
