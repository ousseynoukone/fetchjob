'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useCVStore } from '@/lib/cv-store';
import apiClient from '@/lib/api-client';

// Renders the actual generated PDF (via /api/cv/pdf) instead of a hand-built
// CSS approximation — the old approach used CSS px for a value the backend
// treats as pt, and never showed real page breaks, so it looked meaningfully
// different from the real download once font size could affect page count.
export default function CVPreview() {
  const { cv } = useCVStore();
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const currentUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!cv) return;
    const id = ++requestId.current;
    setLoading(true);
    apiClient
      .get('/api/cv/pdf', { responseType: 'blob' })
      .then((response) => {
        if (id !== requestId.current) return; // a newer save has already superseded this fetch
        const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
        if (currentUrl.current) window.URL.revokeObjectURL(currentUrl.current);
        currentUrl.current = url;
        setPdfUrl(url);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [cv]);

  useEffect(
    () => () => {
      if (currentUrl.current) window.URL.revokeObjectURL(currentUrl.current);
    },
    [],
  );

  if (!cv) return null;

  return (
    <div className="relative w-full h-[80vh] bg-white">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70 z-10">
          <span className="loading loading-spinner loading-lg" />
        </div>
      )}
      {pdfUrl && (
        <iframe src={`${pdfUrl}#toolbar=0&navpanes=0`} className="w-full h-full border-0" title="Aperçu du CV" />
      )}
    </div>
  );
}
