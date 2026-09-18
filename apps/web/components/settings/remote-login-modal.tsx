'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import apiClient from '@/lib/api-client';
import { SupportedPlatform } from '@/lib/platform-credentials-store';
import { X, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';

// Native resolution the backend's CDP screencast renders at (see
// remote-login.service.ts) — every click/wheel coordinate sent back has to
// be in THIS space, not the on-screen display size, since the image is
// scaled to fit the modal via CSS.
const NATIVE_WIDTH = 1280;
const NATIVE_HEIGHT = 800;

const PLATFORM_LABELS: Record<SupportedPlatform, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  france_travail: 'France Travail',
  hellowork: 'HelloWork',
};

type Status = 'connecting' | 'active' | 'done' | 'error';

export default function RemoteLoginModal({
  platform,
  onClose,
  onLoggedIn,
}: {
  platform: SupportedPlatform;
  onClose: () => void;
  onLoggedIn: () => void;
}) {
  const [status, setStatus] = useState<Status>('connecting');
  const [message, setMessage] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Every event here matters in the exact order it happened (a mouse release
  // has to land after its own press; keystrokes have to land in the order
  // typed) -- firing each as its own unawaited POST let the browser send
  // them out of order under any real typing speed, which is exactly what
  // made typing "not work". Chained onto this promise instead, so each
  // event's request only starts once the previous one has actually been
  // sent.
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());

  const sendInput = useCallback((event: Record<string, any>) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    inputQueueRef.current = inputQueueRef.current.then(() =>
      apiClient
        .post(`/api/parametres/identifiants/${platform}/remote-login/${sessionId}/input`, event)
        .then(() => {})
        .catch(() => {}),
    );
  }, [platform]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await apiClient.post(`/api/parametres/identifiants/${platform}/remote-login/start`);
        if (cancelled) return;
        const sessionId = res.data.sessionId as string;
        sessionIdRef.current = sessionId;

        const source = new EventSource(
          `${apiClient.defaults.baseURL}/api/parametres/identifiants/${platform}/remote-login/${sessionId}/stream`,
        );
        sourceRef.current = source;

        source.onmessage = (event) => {
          let payload: { dataUrl: string | null; status: Status; message?: string };
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          if (payload.dataUrl) setFrame(payload.dataUrl);
          setStatus(payload.status);
          if (payload.message) setMessage(payload.message);
          if (payload.status === 'done') {
            onLoggedIn();
            source.close();
          }
        };
        source.onerror = () => {
          // A closed stream (session finished) also fires onerror -- only
          // surface it as a real problem if we never got past "connecting".
          setStatus((s) => (s === 'connecting' ? 'error' : s));
        };
      } catch (error: any) {
        if (!cancelled) {
          setStatus('error');
          setMessage(error.response?.data?.message || 'Impossible de démarrer la session.');
        }
      }
    })();

    return () => {
      cancelled = true;
      sourceRef.current?.close();
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        apiClient.post(`/api/parametres/identifiants/${platform}/remote-login/${sessionId}/stop`).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  const toNativeCoords = (e: React.MouseEvent<HTMLImageElement>) => {
    const rect = imgRef.current!.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * NATIVE_WIDTH;
    const y = ((e.clientY - rect.top) / rect.height) * NATIVE_HEIGHT;
    return { x, y };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLImageElement>) => {
    inputRef.current?.focus();
    const { x, y } = toNativeCoords(e);
    sendInput({ kind: 'mousePressed', x, y });
    sendInput({ kind: 'mouseReleased', x, y });
  };

  const handleWheel = (e: React.WheelEvent<HTMLImageElement>) => {
    const { x, y } = toNativeCoords(e as any);
    sendInput({ kind: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', 'Backspace', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault();
      sendInput({ kind: 'key', key: e.key });
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      sendInput({ kind: 'insertText', text: e.key });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-base-100 rounded-2xl shadow-2xl w-full max-w-3xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-base-300">
          <div>
            <h3 className="font-semibold text-sm">Connexion {PLATFORM_LABELS[platform]}</h3>
            <p className="text-xs text-base-content/50">
              Connectez-vous comme dans un navigateur normal — cliquez et tapez directement dans l'aperçu.
            </p>
          </div>
          <button className="btn btn-ghost btn-xs btn-circle" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative bg-black" style={{ aspectRatio: `${NATIVE_WIDTH} / ${NATIVE_HEIGHT}` }}>
          {frame ? (
            <img
              ref={imgRef}
              src={frame}
              alt="Navigateur en direct"
              className="w-full h-full cursor-pointer select-none"
              onMouseDown={handleMouseDown}
              onWheel={handleWheel}
              draggable={false}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-base-content/40">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          )}

          {/* Invisible focus target that actually receives keystrokes and relays them */}
          <input
            ref={inputRef}
            type="text"
            value=""
            onChange={() => {}}
            onKeyDown={handleKeyDown}
            className="absolute opacity-0 pointer-events-none w-1 h-1"
            autoFocus
          />

          {status === 'done' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
              <div className="flex items-center gap-2 text-success bg-base-100 rounded-xl px-4 py-3">
                <CheckCircle2 className="w-5 h-5" />
                <span className="text-sm font-medium">{message || 'Connecté !'}</span>
              </div>
            </div>
          )}
          {status === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
              <div className="flex items-center gap-2 text-error bg-base-100 rounded-xl px-4 py-3 max-w-md text-center">
                <AlertTriangle className="w-5 h-5 shrink-0" />
                <span className="text-sm font-medium">{message || 'Une erreur est survenue.'}</span>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-base-300 flex items-center justify-between">
          <span className="text-xs text-base-content/50">
            {status === 'connecting' && 'Ouverture du navigateur...'}
            {status === 'active' && 'Session active — cliquez dans la fenêtre pour interagir.'}
            {status === 'done' && 'Terminé.'}
            {status === 'error' && 'Échec.'}
          </span>
          <button className="btn btn-ghost btn-xs" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
