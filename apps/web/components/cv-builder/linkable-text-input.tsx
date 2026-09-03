'use client';

import React, { useRef, useState } from 'react';
import { Link2 } from 'lucide-react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

// A plain text input where selecting a substring lets you turn it into a
// link — writes `[mot](url)` into the value at the selected range rather
// than requiring a separate URL field, so the link lives on the word
// itself (see lib/inline-links.tsx for how that's rendered back out).
export default function LinkableTextInput({ value, onChange, placeholder, className }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [showPopover, setShowPopover] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');

  const handleSelect = () => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end > start) {
      setSelection({ start, end });
    } else if (!showPopover) {
      setSelection(null);
    }
  };

  const applyLink = () => {
    if (!selection || !urlDraft.trim()) return;
    const before = value.slice(0, selection.start);
    const selected = value.slice(selection.start, selection.end);
    const after = value.slice(selection.end);
    onChange(`${before}[${selected}](${urlDraft.trim()})${after}`);
    setShowPopover(false);
    setUrlDraft('');
    setSelection(null);
  };

  const cancelPopover = () => {
    setShowPopover(false);
    setUrlDraft('');
    setSelection(null);
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onSelect={handleSelect}
        onBlur={() => setTimeout(() => { if (!showPopover) setSelection(null); }, 150)}
        className={className}
      />

      {selection && !showPopover && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowPopover(true)}
          className="absolute -top-7 right-0 btn btn-xs btn-outline gap-1 z-10"
        >
          <Link2 className="w-3 h-3" /> Lien
        </button>
      )}

      {showPopover && (
        <div className="absolute -top-10 right-0 z-20 flex gap-1 bg-base-100 border border-base-300 rounded-lg p-1 shadow-lg">
          <input
            type="url"
            autoFocus
            placeholder="https://..."
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink();
              if (e.key === 'Escape') cancelPopover();
            }}
            className="input input-bordered input-xs w-44"
          />
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={applyLink} className="btn btn-xs btn-primary">
            OK
          </button>
        </div>
      )}
    </div>
  );
}
