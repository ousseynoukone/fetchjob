'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import apiClient from '@/lib/api-client';
import { SupportedPlatform } from '@/lib/platform-credentials-store';
import {
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Send,
  RotateCw,
  CornerDownLeft,
  ArrowRight,
  Delete,
  Sparkles,
  Eye,
  EyeOff,
} from 'lucide-react';

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
  welcome_to_the_jungle: 'Welcome to the Jungle',
  apec: 'APEC',
  gmail: 'Gmail',
  free_work: 'Free-Work',
};

type Status = 'connecting' | 'active' | 'done' | 'error';

export default function RemoteLoginModal({
  platform,
  targetUrl,
  onClose,
  onLoggedIn,
}: {
  platform: SupportedPlatform;
  targetUrl?: string;
  onClose: () => void;
  onLoggedIn: () => void;
}) {
  const [status, setStatus] = useState<Status>('connecting');
  const [message, setMessage] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const typeBoxRef = useRef<HTMLInputElement>(null);
  const lastMouseMoveRef = useRef(0);

  // Serialized queue for CDP events ensuring ordering
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const intentionalCloseRef = useRef(false);

  const sendInput = useCallback(
    (event: Record<string, any>) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      inputQueueRef.current = inputQueueRef.current.then(() =>
        apiClient
          .post(`/api/parametres/identifiants/${platform}/remote-login/${sessionId}/input`, event)
          .then(() => {})
          .catch(() => {}),
      );
    },
    [platform],
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const payload = targetUrl ? { targetUrl } : {};
        const res = await apiClient.post(`/api/parametres/identifiants/${platform}/remote-login/start`, payload);
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

          if (payload.status === 'error' || payload.status === 'done') {
            setStatus(payload.status);
            if (payload.message) setMessage(payload.message);
            if (payload.status === 'done') {
              // Not closing the source! Let it continue to receive active frames
              intentionalCloseRef.current = true;
              onLoggedIn();
            } else if (payload.status === 'error') {
              source.close();
            }
          } else {
            // Keep the 'done' status visible if it was already achieved
            setStatus((prev) => (prev === 'done' ? 'done' : 'active'));
          }
        };
        source.onerror = () => {
          if (intentionalCloseRef.current) return;
          setStatus('error');
          setMessage((m) => m || 'Connexion au serveur perdue — fermez et rouvrez cette fenêtre pour réessayer.');
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

  const handleMouseMove = (e: React.MouseEvent<HTMLImageElement>) => {
    const now = Date.now();
    if (now - lastMouseMoveRef.current < 50) return;
    lastMouseMoveRef.current = now;
    const { x, y } = toNativeCoords(e);
    sendInput({ kind: 'mouseMoved', x, y });
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLImageElement>) => {
    const { x, y } = toNativeCoords(e);
    sendInput({ kind: 'mouseMoved', x, y });
    sendInput({ kind: 'mousePressed', x, y });
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLImageElement>) => {
    const { x, y } = toNativeCoords(e);
    sendInput({ kind: 'mouseReleased', x, y });
  };

  const handleWheel = (e: React.WheelEvent<HTMLImageElement>) => {
    const { x, y } = toNativeCoords(e as any);
    sendInput({ kind: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY });
  };

  const handleConfirm = async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    setConfirming(true);
    try {
      const res = await apiClient.post(
        `/api/parametres/identifiants/${platform}/remote-login/${sessionId}/confirm`,
      );
      setMessage(res.data.message);
      if (res.data.success) {
        intentionalCloseRef.current = true;
        setStatus('done');
        onLoggedIn();
        sourceRef.current?.close();
      }
    } catch (error: any) {
      setMessage(error.response?.data?.message || 'Échec de la confirmation.');
    } finally {
      setConfirming(false);
    }
  };

  const handleSendText = useCallback(
    (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (!textInput) return;
      sendInput({ kind: 'insertText', text: textInput });
      setTextInput('');
    },
    [sendInput, textInput],
  );

  // Global key listener with AltGr fix for Windows French AZERTY keyboards
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if currently typing inside the helper text box
      if (document.activeElement === typeBoxRef.current) {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleSendText();
        }
        return;
      }

      if (['Enter', 'Backspace', 'Tab', 'Escape'].includes(e.key)) {
        e.preventDefault();
        sendInput({ kind: 'key', key: e.key as any });
        return;
      }

      // Fix AltGr on Windows (which sends both ctrlKey and altKey) so @, #, etc. work properly
      const isAltGr = (e.ctrlKey && e.altKey) || e.getModifierState?.('AltGraph');
      const isPlainChar = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key.length === 1 && (isPlainChar || isAltGr)) {
        e.preventDefault();
        sendInput({ kind: 'insertText', text: e.key });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [sendInput, textInput]);

  // Handle paste directly into the remote browser
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (document.activeElement === typeBoxRef.current) return;
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      e.preventDefault();
      sendInput({ kind: 'insertText', text });
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, [sendInput]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4 backdrop-blur-sm">
      <div className="bg-base-100 rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden border border-base-300 flex flex-col max-h-[95vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-base-300 bg-base-200/50">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
            <h3 className="font-semibold text-sm">Navigateur Intégré — Connexion {PLATFORM_LABELS[platform]}</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-ghost btn-xs gap-1 text-base-content/70 hover:text-base-content"
              onClick={() => sendInput({ kind: 'reload' })}
              title="Recharger la page"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Actualiser</span>
            </button>
            <button className="btn btn-ghost btn-xs btn-circle" onClick={onClose}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Live Screencast Viewport */}
        <div className="relative bg-black flex-1 min-h-0 flex items-center justify-center overflow-hidden" style={{ aspectRatio: `${NATIVE_WIDTH} / ${NATIVE_HEIGHT}` }}>
          {frame ? (
            <img
              ref={imgRef}
              src={frame}
              alt="Navigateur distant"
              className="w-full h-full cursor-crosshair select-none object-contain"
              onMouseMove={handleMouseMove}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onWheel={handleWheel}
              draggable={false}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-base-content/50 py-16">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <span className="text-xs">Chargement du navigateur distant et initialisation de la session...</span>
            </div>
          )}

          {status === 'done' && (
            <div className="absolute top-4 right-4 z-50 flex items-center gap-2 text-success bg-base-100 rounded-lg px-4 py-2 shadow-lg border border-success/30 pointer-events-none">
              <CheckCircle2 className="w-5 h-5" />
              <span className="text-xs font-semibold">Session enregistrée ! Vous pouvez continuer à utiliser le navigateur.</span>
            </div>
          )}

          {status === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/75 backdrop-blur-xs">
              <div className="flex items-center gap-3 text-error bg-base-100 rounded-2xl px-6 py-4 shadow-2xl border border-error/30 max-w-md">
                <AlertTriangle className="w-6 h-6 shrink-0" />
                <div>
                  <h4 className="text-sm font-semibold text-base-content">Erreur</h4>
                  <p className="text-xs text-base-content/70">{message || 'Une erreur est survenue.'}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Control & Assistant Toolbar */}
        <div className="px-5 py-3 border-t border-base-300 bg-base-100 space-y-2.5">
          {/* Direct typing and text-insertion helper bar */}
          <form onSubmit={handleSendText} className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                ref={typeBoxRef}
                type={showPassword ? 'text' : 'text'}
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Tapez ou collez un texte (identifiant, mot de passe, code 2FA)..."
                className="input input-sm input-bordered w-full pr-16 font-mono text-xs"
                autoComplete="off"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs p-1"
                onClick={() => setShowPassword(!showPassword)}
                title={showPassword ? 'Masquer' : 'Afficher'}
              >
                {showPassword ? <EyeOff className="w-3.5 h-3.5 text-base-content/60" /> : <Eye className="w-3.5 h-3.5 text-base-content/60" />}
              </button>
            </div>
            <button
              type="submit"
              disabled={!textInput}
              className="btn btn-primary btn-sm gap-1.5 shrink-0"
              title="Insère le texte dans le champ actif de la fenêtre ci-dessus"
            >
              <Send className="w-3.5 h-3.5" />
              <span className="text-xs">Insérer</span>
            </button>
          </form>

          {/* Quick Action Navigation & Helper Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-base-200">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="btn btn-outline btn-xs gap-1"
                onClick={() => sendInput({ kind: 'prefill' })}
                title="Pré-remplir automatiquement l'identifiant et mot de passe enregistrés"
              >
                <Sparkles className="w-3 h-3 text-warning" />
                <span>Pré-remplir</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs gap-1"
                onClick={() => sendInput({ kind: 'key', key: 'Tab' })}
                title="Champ suivant (Touche Tab)"
              >
                <ArrowRight className="w-3 h-3" />
                <span>Tab</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs gap-1"
                onClick={() => sendInput({ kind: 'key', key: 'Enter' })}
                title="Valider le formulaire (Touche Entrée)"
              >
                <CornerDownLeft className="w-3 h-3" />
                <span>Entrée</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs gap-1"
                onClick={() => sendInput({ kind: 'key', key: 'Backspace' })}
                title="Effacer le dernier caractère"
              >
                <Delete className="w-3 h-3" />
                <span>Effacer</span>
              </button>
            </div>

            <div className="flex items-center gap-2 ml-auto">
              {status === 'active' && (
                <button
                  type="button"
                  className="btn btn-success btn-xs gap-1.5 text-white shadow-xs"
                  onClick={handleConfirm}
                  disabled={confirming}
                  title="Enregistre la session active dès que vous êtes connecté"
                >
                  {confirming ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  <span>Valider la connexion (J'ai terminé)</span>
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-xs" onClick={onClose}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
