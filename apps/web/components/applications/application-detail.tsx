'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApplicationsStore } from '@/lib/applications-store';
import apiClient from '@/lib/api-client';
import AppShell from '@/components/layout/app-shell';
import {
  ArrowLeft,
  ExternalLink,
  Check,
  Archive,
  Sparkles,
  Download,
  Building2,
  MapPin,
  AlertCircle,
  Copy,
  FileText,
  CalendarClock,
  CalendarCheck,
} from 'lucide-react';

function formatDateTime(iso?: string) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const TABS = ['Offre', 'CV adapté', 'Lettre de motivation', 'Analyse IA', 'Matching'];

const STATUS_LABEL: Record<string, string> = {
  to_apply: 'À postuler',
  applied: 'Envoyée',
  interview: 'Entretien',
  offer: 'Offre',
  rejected: 'Refusée',
  ignored: 'Ignorée',
};

const STATUS_STYLE: Record<string, string> = {
  to_apply: 'badge-info',
  applied: 'badge-primary',
  interview: 'badge-warning',
  offer: 'badge-success',
  rejected: 'badge-error',
  ignored: 'badge-ghost',
};

export default function ApplicationDetail({ id }: { id: string }) {
  const router = useRouter();
  const { current, loading, error, fetchById, updateStatus, markApplied, regenerate } = useApplicationsStore();
  const [tab, setTab] = useState('Offre');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetchById(id);
  }, [id, fetchById]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleAction = async (action: string, fn: () => Promise<any>, successMessage?: string) => {
    setBusy(action);
    try {
      await fn();
      if (successMessage) setNotice(successMessage);
    } catch {
      // error is already surfaced via the store's `error` state and the toast below
    } finally {
      setBusy(null);
    }
  };

  const handleDownloadCv = async () => {
    setBusy('cv');
    try {
      const response = await apiClient.get(`/api/candidatures/${id}/cv`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `cv-${current?.company || 'candidature'}.pdf`;
      link.click();
      window.URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  };

  const handleDownloadCoverLetterPdf = async () => {
    setBusy('letter-pdf');
    try {
      const response = await apiClient.get(`/api/candidatures/${id}/lettre`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `lettre-${current?.company || 'candidature'}.pdf`;
      link.click();
      window.URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  };

  const handleCopyCoverLetter = async () => {
    if (!current?.coverLetter) return;
    await navigator.clipboard.writeText(current.coverLetter);
    setNotice('Lettre copiée');
  };

  if (loading && !current) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-screen">
          <span className="loading loading-spinner loading-lg" />
        </div>
      </AppShell>
    );
  }

  if (!current) return null;

  return (
    <AppShell>
      <div className="max-w-4xl mx-auto px-8 py-10">
        <button
          onClick={() => router.push('/candidatures')}
          className="flex items-center gap-1.5 text-sm text-base-content/50 hover:text-base-content mb-6"
        >
          <ArrowLeft className="w-4 h-4" /> Retour aux candidatures
        </button>

        <div className="bg-base-200 border border-base-300 rounded-2xl p-6 mb-6">
          <div className="flex justify-between items-start gap-4">
            <div>
              <h1 className="text-2xl font-semibold">{current.jobTitle}</h1>
              <div className="flex items-center gap-4 text-sm text-base-content/50 mt-2">
                <span className="flex items-center gap-1.5">
                  <Building2 className="w-4 h-4" /> {current.company}
                </span>
                {current.location && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="w-4 h-4" /> {current.location}
                  </span>
                )}
                <span className="capitalize badge badge-ghost badge-sm">
                  {current.jobOffer?.source?.replace('_', ' ')}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs text-base-content/40 mt-2">
                {formatDateTime(current.jobOffer?.postedAt) && (
                  <span className="flex items-center gap-1.5" title="Date de publication sur le site source">
                    <CalendarClock className="w-3.5 h-3.5" /> Publiée le {formatDateTime(current.jobOffer?.postedAt)}
                  </span>
                )}
                {formatDateTime(current.jobOffer?.scrapedAt) && (
                  <span className="flex items-center gap-1.5" title="Date de récupération de l'offre">
                    <CalendarCheck className="w-3.5 h-3.5" /> Récupérée le {formatDateTime(current.jobOffer?.scrapedAt)}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              <div className="text-3xl font-bold text-primary">{current.matchScore}</div>
              <span className={`badge ${STATUS_STYLE[current.status] || 'badge-ghost'} badge-sm`}>
                {STATUS_LABEL[current.status] || current.status}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mt-5">
            <a href={current.sourceUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm gap-2">
              <ExternalLink className="w-4 h-4" /> Postuler
            </a>
            <button
              className="btn btn-outline btn-sm gap-2"
              disabled={busy === 'applied'}
              onClick={() => handleAction('applied', () => markApplied(id), 'Marquée comme envoyée')}
            >
              <Check className="w-4 h-4" /> Marquer comme envoyée
            </button>
            {current.status === 'ignored' ? (
              <button
                className="btn btn-ghost btn-sm gap-2"
                disabled={busy === 'ignore'}
                onClick={() => handleAction('ignore', () => updateStatus(id, 'to_apply'), 'Candidature restaurée')}
              >
                <Archive className="w-4 h-4" /> Restaurer
              </button>
            ) : (
              <button
                className="btn btn-ghost btn-sm gap-2"
                disabled={busy === 'ignore'}
                onClick={() => handleAction('ignore', () => updateStatus(id, 'ignored'), 'Candidature ignorée')}
              >
                <Archive className="w-4 h-4" /> Ignorer
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm gap-2"
              disabled={busy === 'regen'}
              onClick={() => handleAction('regen', () => regenerate(id), 'Régénéré avec succès')}
            >
              <Sparkles className="w-4 h-4" /> {busy === 'regen' ? 'Génération...' : "Régénérer avec l'IA"}
            </button>
          </div>
        </div>

        <div className="flex gap-1 mb-4 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                tab === t
                  ? 'bg-primary/15 text-primary'
                  : 'text-base-content/50 hover:text-base-content hover:bg-base-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="bg-base-200 border border-base-300 rounded-2xl p-6 min-h-[240px]">
          {tab === 'Offre' && (
            <p className="text-sm leading-relaxed whitespace-pre-line text-base-content/80">
              {current.jobOffer?.description || 'Aucune description disponible.'}
            </p>
          )}

          {tab === 'CV adapté' && (
            <div>
              <p className="text-sm text-base-content/50 mb-4">
                CV adapté par l'IA à cette offre (ou votre CV de base si la génération n'a pas encore eu lieu).
              </p>
              <button className="btn btn-primary btn-sm gap-2" disabled={busy === 'cv'} onClick={handleDownloadCv}>
                <Download className="w-4 h-4" /> {busy === 'cv' ? 'Génération...' : 'Télécharger le PDF'}
              </button>
            </div>
          )}

          {tab === 'Lettre de motivation' && (
            <div>
              {current.coverLetter && (
                <div className="flex gap-2 mb-4">
                  <button className="btn btn-outline btn-sm gap-2" onClick={handleCopyCoverLetter}>
                    <Copy className="w-4 h-4" /> Copier
                  </button>
                  <button
                    className="btn btn-outline btn-sm gap-2"
                    disabled={busy === 'letter-pdf'}
                    onClick={handleDownloadCoverLetterPdf}
                  >
                    <FileText className="w-4 h-4" /> {busy === 'letter-pdf' ? 'Génération...' : 'Télécharger en PDF'}
                  </button>
                </div>
              )}
              <p className="text-sm leading-relaxed whitespace-pre-line text-base-content/80">
                {current.coverLetter || "Pas encore générée. Cliquez sur \"Régénérer avec l'IA\"."}
              </p>
            </div>
          )}

          {tab === 'Analyse IA' && (
            <div className="space-y-4">
              {current.aiAnalysis ? (
                <>
                  {!!current.aiAnalysis.strengths?.length && (
                    <div>
                      <p className="text-sm font-semibold text-success mb-1">Points forts</p>
                      <ul className="text-sm text-base-content/70 list-disc list-inside space-y-0.5">
                        {current.aiAnalysis.strengths.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {!!current.aiAnalysis.gaps?.length && (
                    <div>
                      <p className="text-sm font-semibold text-warning mb-1">Points faibles</p>
                      <ul className="text-sm text-base-content/70 list-disc list-inside space-y-0.5">
                        {current.aiAnalysis.gaps.map((g, i) => (
                          <li key={i}>{g}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {current.aiAnalysis.advice && (
                    <div>
                      <p className="text-sm font-semibold mb-1">Conseils</p>
                      <p className="text-sm text-base-content/70">{current.aiAnalysis.advice}</p>
                    </div>
                  )}
                  {current.aiAnalysis.recommendation && (
                    <div>
                      <p className="text-sm font-semibold mb-1">Recommandation</p>
                      <p className="text-sm text-base-content/70">{current.aiAnalysis.recommendation} / 5</p>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-base-content/50">
                  Pas encore générée. Cliquez sur "Régénérer avec l'IA".
                </p>
              )}
            </div>
          )}

          {tab === 'Matching' && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-semibold text-success mb-2">Compétences correspondantes</p>
                <div className="flex flex-wrap gap-1.5">
                  {current.matchedSkills.length ? (
                    current.matchedSkills.map((s, i) => (
                      <span key={i} className="badge badge-success badge-outline">
                        {s}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-base-content/40">Aucune</span>
                  )}
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold text-warning mb-2">Compétences manquantes</p>
                <div className="flex flex-wrap gap-1.5">
                  {current.missingSkills.length ? (
                    current.missingSkills.map((s, i) => (
                      <span key={i} className="badge badge-warning badge-outline">
                        {s}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-base-content/40">Aucune</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-sm font-medium bg-error text-error-content max-w-sm">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        </div>
      )}

      {!error && notice && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-sm font-medium bg-success text-success-content max-w-sm">
            <Check className="w-4 h-4 shrink-0" /> {notice}
          </div>
        </div>
      )}
    </AppShell>
  );
}
