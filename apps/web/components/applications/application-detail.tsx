'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useApplicationsStore } from '@/lib/applications-store';
import apiClient from '@/lib/api-client';
import AppShell from '@/components/layout/app-shell';
import RemoteLoginModal from '@/components/settings/remote-login-modal';
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
  RotateCcw,
  HelpCircle,
  Copy,
  FileText,
  CalendarClock,
  CalendarCheck,
  Phone,
  Video,
  Users,
  Code2,
  Trophy,
  XCircle,
  MessageSquare,
  Pencil,
  Save,
  X,
  Clock,
  Euro,
  ChevronDown,
  Star,
} from 'lucide-react';

function formatDateTime(iso?: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateForInput(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, 16); // "YYYY-MM-DDTHH:mm"
}

// The API already names these files (see buildCvFileName) — honour it rather
// than inventing a name here. Falls back only if the header is unreadable.
function fileNameFromResponse(response: { headers?: Record<string, unknown> }, fallback: string): string {
  const header = String(response.headers?.['content-disposition'] ?? '');
  const match = /filename\*?=(?:UTF-8'')?\"?([^";]+)\"?/i.exec(header);
  return match ? decodeURIComponent(match[1].trim()) : fallback;
}

const TABS = ['Offre', 'Suivi', 'CV adapté', 'Lettre de motivation', 'Analyse IA', 'Matching'];

const STATUS_LABEL: Record<string, string> = {
  to_apply: 'À postuler',
  applied: 'Envoyée',
  interview: 'Entretien',
  offer: 'Offre reçue',
  rejected: 'Refusée',
  ignored: 'Ignorée',
  needs_review: 'À vérifier',
};

const STATUS_STYLE: Record<string, string> = {
  to_apply: 'badge-info',
  applied: 'badge-primary',
  interview: 'badge-warning',
  offer: 'badge-success',
  rejected: 'badge-error',
  ignored: 'badge-ghost',
  needs_review: 'badge-warning',
};

const INTERVIEW_TYPES = [
  { value: 'Téléphonique', label: 'Téléphonique', icon: Phone, color: 'text-blue-400' },
  { value: 'Visio', label: 'Visio / Teams / Zoom', icon: Video, color: 'text-purple-400' },
  { value: 'Présentiel', label: 'Présentiel', icon: Users, color: 'text-emerald-400' },
  { value: 'Technique', label: 'Test Technique', icon: Code2, color: 'text-amber-400' },
  { value: 'RH', label: 'Entretien RH', icon: Star, color: 'text-pink-400' },
];

// Status pipeline steps
const PIPELINE_STEPS = [
  { status: 'to_apply', label: 'À postuler', color: 'bg-info' },
  { status: 'applied', label: 'Envoyée', color: 'bg-primary' },
  { status: 'interview', label: 'Entretien', color: 'bg-warning' },
  { status: 'offer', label: 'Offre', color: 'bg-success' },
];

const REJECTED_STEP = { status: 'rejected', label: 'Refusée', color: 'bg-error' };

function getPipelineIndex(status: string) {
  const idx = PIPELINE_STEPS.findIndex((s) => s.status === status);
  return idx >= 0 ? idx : -1;
}

export default function ApplicationDetail({ id }: { id: string }) {
  const router = useRouter();
  const { current, loading, error, fetchById, updateStatus, markApplied, regenerate, retryOne, updateTracking } = useApplicationsStore();
  const [tab, setTab] = useState('Offre');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showRemoteLogin, setShowRemoteLogin] = useState(false);

  // Tracking form state
  const [trackingEdit, setTrackingEdit] = useState(false);
  const [trackingForm, setTrackingForm] = useState({
    interviewDate: '',
    interviewType: '',
    feedbackNote: '',
    offerSalary: '',
  });

  useEffect(() => {
    fetchById(id);
  }, [id, fetchById]);

  // Sync form with current data when application loads or changes
  useEffect(() => {
    if (current) {
      setTrackingForm({
        interviewDate: formatDateForInput(current.interviewDate),
        interviewType: current.interviewType ?? '',
        feedbackNote: current.feedbackNote ?? '',
        offerSalary: current.offerSalary ?? '',
      });
    }
  }, [current?.id, current?.interviewDate, current?.interviewType, current?.feedbackNote, current?.offerSalary]);

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

  const handleStatusChange = async (newStatus: string) => {
    setBusy('status-' + newStatus);
    try {
      await updateTracking(id, { status: newStatus });
    } finally {
      setBusy(null);
    }
  };

  const handleSaveTracking = async () => {
    setBusy('save-tracking');
    try {
      await updateTracking(id, {
        interviewDate: trackingForm.interviewDate || null,
        interviewType: trackingForm.interviewType || null,
        feedbackNote: trackingForm.feedbackNote || null,
        offerSalary: trackingForm.offerSalary || null,
      });
      setTrackingEdit(false);
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
      link.download = fileNameFromResponse(response, 'CV.pdf');
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
      link.download = fileNameFromResponse(response, 'lettre-de-motivation.pdf');
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

  const pipelineIdx = getPipelineIndex(current.status);
  const isRejected = current.status === 'rejected';

  return (
    <AppShell>
      <div className="max-w-4xl mx-auto px-8 py-10">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-base-content/50 hover:text-base-content mb-6"
        >
          <ArrowLeft className="w-4 h-4" /> Retour aux candidatures
        </button>

        {/* Header Card */}
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
                {current.jobOffer?.applyMode === 'internal' && (
                  <span className="badge badge-success badge-outline badge-sm" title="La candidature se fait directement sur la plateforme">
                    Candidature interne
                  </span>
                )}
                {current.jobOffer?.applyMode === 'external' && (
                  <span className="badge badge-warning badge-outline badge-sm" title="La plateforme redirige vers le site du recruteur">
                    Redirection externe
                  </span>
                )}
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

          {/* Status Pipeline */}
          <div className="mt-5 pt-5 border-t border-base-300/50">
            <p className="text-xs text-base-content/40 mb-3 font-medium uppercase tracking-wider">Progression de la candidature</p>
            <div className="flex items-center gap-0">
              {PIPELINE_STEPS.map((step, idx) => {
                const isActive = current.status === step.status;
                const isPassed = !isRejected && pipelineIdx > idx;
                const isCurrent = isActive;
                return (
                  <React.Fragment key={step.status}>
                    <button
                      onClick={() => !isCurrent && handleStatusChange(step.status)}
                      disabled={!!busy || isCurrent}
                      title={`Marquer comme "${step.label}"`}
                      className={`flex flex-col items-center px-3 py-2 rounded-xl text-xs font-medium transition-all gap-1 ${
                        isCurrent
                          ? 'bg-primary/20 text-primary border border-primary/40 cursor-default'
                          : isPassed
                          ? 'bg-success/10 text-success/70 border border-success/20 hover:bg-success/20 hover:text-success cursor-pointer'
                          : 'bg-base-300/30 text-base-content/40 border border-base-300/50 hover:bg-base-300/60 hover:text-base-content/70 cursor-pointer'
                      }`}
                    >
                      {isPassed && !isCurrent ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <div className={`w-2.5 h-2.5 rounded-full ${isCurrent ? 'bg-primary animate-pulse' : isPassed ? 'bg-success' : 'bg-base-content/20'}`} />
                      )}
                      {step.label}
                    </button>
                    {idx < PIPELINE_STEPS.length - 1 && (
                      <div className={`h-0.5 flex-1 min-w-[16px] ${isPassed && !isRejected ? 'bg-success/40' : 'bg-base-300/50'}`} />
                    )}
                  </React.Fragment>
                );
              })}
              {/* Rejected step — outside the main pipeline */}
              <div className="flex items-center gap-0 ml-2">
                <div className="h-0.5 w-4 border-t-2 border-dashed border-base-300/40" />
                <button
                  onClick={() => !isRejected && handleStatusChange('rejected')}
                  disabled={!!busy || isRejected}
                  title="Marquer comme refusée"
                  className={`flex flex-col items-center px-3 py-2 rounded-xl text-xs font-medium transition-all gap-1 ${
                    isRejected
                      ? 'bg-error/20 text-error border border-error/40 cursor-default'
                      : 'bg-base-300/20 text-base-content/40 border border-base-300/30 hover:bg-error/10 hover:text-error/70 hover:border-error/20 cursor-pointer'
                  }`}
                >
                  <XCircle className="w-3.5 h-3.5" />
                  {REJECTED_STEP.label}
                </button>
              </div>
            </div>
          </div>

          {/* Alerts */}
          {current.status === 'needs_review' && current.autoApplyNote && (
            <div className="alert alert-warning mt-5 text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <span>
                  <strong>Auto-apply incomplet :</strong> {current.autoApplyNote}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0 self-start sm:self-auto">
                <button
                  className="btn btn-primary btn-xs gap-1.5"
                  onClick={() => setShowRemoteLogin(true)}
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Finaliser manuellement
                </button>
                <button
                  className="btn btn-warning btn-xs gap-1.5"
                  disabled={busy === 'retry'}
                  onClick={() => handleAction('retry', () => retryOne(id), 'Auto-apply relancé')}
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Réessayer cette offre
                </button>
                <Link href="/questions" className="btn btn-outline btn-warning btn-xs gap-1.5">
                  <HelpCircle className="w-3.5 h-3.5" /> Questions manquantes
                </Link>
              </div>
            </div>
          )}

          {current.status === 'applied' && (
            <div className={`alert mt-5 text-sm ${current.verifiedAt ? 'alert-success' : 'alert-warning'}`}>
              <AlertCircle className="w-4 h-4" />
              <span>
                {current.verifiedAt ? (
                  <>
                    <strong>Confirmée</strong> par la plateforme le{' '}
                    {new Date(current.verifiedAt).toLocaleString('fr-FR')}.
                  </>
                ) : current.verificationNote ? (
                  <>
                    <strong>Non confirmée :</strong> {current.verificationNote}
                  </>
                ) : (
                  <>Pas encore vérifiée — lancez une vérification depuis la page Vérification.</>
                )}
              </span>
            </div>
          )}

          {/* Interview info banner */}
          {current.status === 'interview' && current.interviewDate && (
            <div className="mt-4 bg-warning/10 border border-warning/25 rounded-xl px-4 py-3 flex items-center gap-3">
              <Clock className="w-5 h-5 text-warning shrink-0" />
              <div>
                <p className="text-sm font-semibold text-warning">Entretien prévu</p>
                <p className="text-xs text-base-content/60">
                  {formatDateTime(current.interviewDate)}
                  {current.interviewType && <> · <span className="font-medium">{current.interviewType}</span></>}
                </p>
              </div>
              <button
                onClick={() => { setTab('Suivi'); setTrackingEdit(true); }}
                className="btn btn-xs btn-ghost ml-auto gap-1"
              >
                <Pencil className="w-3 h-3" /> Modifier
              </button>
            </div>
          )}

          {/* Offer info banner */}
          {current.status === 'offer' && current.offerSalary && (
            <div className="mt-4 bg-success/10 border border-success/25 rounded-xl px-4 py-3 flex items-center gap-3">
              <Euro className="w-5 h-5 text-success shrink-0" />
              <div>
                <p className="text-sm font-semibold text-success">Offre reçue</p>
                <p className="text-xs text-base-content/60">Salaire proposé : <strong>{current.offerSalary}</strong></p>
              </div>
            </div>
          )}

          {/* Rejection banner */}
          {current.status === 'rejected' && (
            <div className="mt-4 bg-error/10 border border-error/25 rounded-xl px-4 py-3 flex items-center gap-3">
              <XCircle className="w-5 h-5 text-error shrink-0" />
              <div>
                <p className="text-sm font-semibold text-error">Candidature refusée</p>
                {current.rejectedAt && (
                  <p className="text-xs text-base-content/60">Le {formatDateTime(current.rejectedAt)}</p>
                )}
                {current.feedbackNote && (
                  <p className="text-xs text-base-content/60 mt-0.5 italic">« {current.feedbackNote} »</p>
                )}
              </div>
              <button
                onClick={() => { setTab('Suivi'); setTrackingEdit(true); }}
                className="btn btn-xs btn-ghost ml-auto gap-1"
              >
                <Pencil className="w-3 h-3" /> Notes
              </button>
            </div>
          )}

          {current.screenshotTakenAt && (
            <details className="mt-5" open>
              <summary className="cursor-pointer text-sm text-base-content/60 hover:text-base-content">
                Capture de la tentative ({formatDateTime(current.screenshotTakenAt)})
              </summary>
              <img
                src={`${apiClient.defaults.baseURL}/api/candidatures/${id}/screenshot`}
                alt="Capture d'écran de la page au moment de la candidature"
                className="mt-3 rounded-lg border border-base-300 max-w-full"
              />
            </details>
          )}

          {current.verificationScreenshotTakenAt && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-base-content/60 hover:text-base-content">
                Capture de la dernière vérification ({formatDateTime(current.verificationScreenshotTakenAt)})
              </summary>
              <img
                src={`${apiClient.defaults.baseURL}/api/candidatures/${id}/verification-screenshot`}
                alt="Capture d'écran de la page lors de la dernière vérification"
                className="mt-3 rounded-lg border border-base-300 max-w-full"
              />
            </details>
          )}

          <div className="flex flex-wrap gap-2 mt-5">
            <button
              className="btn btn-warning btn-sm gap-2"
              disabled={busy === 'retry'}
              onClick={() => handleAction('retry', () => retryOne(id), 'Auto-apply relancé')}
              title="Relance l'auto-apply uniquement pour cette candidature"
            >
              <RotateCcw className="w-4 h-4" /> Réessayer l'auto-apply
            </button>
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

        {/* Tabs */}
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
              {t === 'Suivi' && (current.interviewDate || current.feedbackNote || current.offerSalary) && (
                <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-primary inline-block align-middle" />
              )}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="bg-base-200 border border-base-300 rounded-2xl p-6 min-h-[240px]">
          {tab === 'Offre' && (
            <p className="text-sm leading-relaxed whitespace-pre-line text-base-content/80">
              {current.jobOffer?.description || 'Aucune description disponible.'}
            </p>
          )}

          {/* === SUIVI TAB === */}
          {tab === 'Suivi' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">Suivi de la candidature</h2>
                {!trackingEdit ? (
                  <button
                    onClick={() => setTrackingEdit(true)}
                    className="btn btn-ghost btn-sm gap-1.5"
                  >
                    <Pencil className="w-3.5 h-3.5" /> Modifier
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setTrackingEdit(false); }}
                      className="btn btn-ghost btn-sm gap-1"
                    >
                      <X className="w-3.5 h-3.5" /> Annuler
                    </button>
                    <button
                      onClick={handleSaveTracking}
                      disabled={busy === 'save-tracking'}
                      className="btn btn-primary btn-sm gap-1.5"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {busy === 'save-tracking' ? 'Enregistrement...' : 'Enregistrer'}
                    </button>
                  </div>
                )}
              </div>

              {/* Status quick-change buttons */}
              <div>
                <p className="text-xs text-base-content/50 mb-2 font-medium uppercase tracking-wider">Changer le statut</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { s: 'applied', label: 'Envoyée', icon: Check, cls: 'btn-success' },
                    { s: 'interview', label: 'Entretien', icon: Clock, cls: 'btn-warning' },
                    { s: 'offer', label: 'Offre reçue', icon: Trophy, cls: 'btn-accent' },
                    { s: 'rejected', label: 'Refusée', icon: XCircle, cls: 'btn-error' },
                    { s: 'ignored', label: 'Ignorer', icon: Archive, cls: 'btn-ghost' },
                  ].map(({ s, label, icon: Icon, cls }) => (
                    <button
                      key={s}
                      onClick={() => handleStatusChange(s)}
                      disabled={!!busy || current.status === s}
                      className={`btn btn-sm gap-1.5 ${current.status === s ? cls + ' opacity-100 cursor-default' : 'btn-outline opacity-70 hover:opacity-100'}`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {label}
                      {current.status === s && <span className="badge badge-xs badge-neutral ml-0.5">Actuel</span>}
                    </button>
                  ))}
                </div>
              </div>

              <div className="divider my-2" />

              {/* Entretien section */}
              <div className="bg-base-300/30 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2 mb-1">
                  <Clock className="w-4 h-4 text-warning" />
                  <h3 className="text-sm font-semibold">Entretien</h3>
                </div>

                {trackingEdit ? (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-base-content/50 mb-1 block">Date et heure</label>
                      <input
                        type="datetime-local"
                        value={trackingForm.interviewDate}
                        onChange={(e) => setTrackingForm((f) => ({ ...f, interviewDate: e.target.value }))}
                        className="input input-sm input-bordered w-full max-w-xs bg-base-100/70"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-base-content/50 mb-1.5 block">Type d'entretien</label>
                      <div className="flex flex-wrap gap-2">
                        {INTERVIEW_TYPES.map((t) => {
                          const Icon = t.icon;
                          const isSelected = trackingForm.interviewType === t.value;
                          return (
                            <button
                              key={t.value}
                              type="button"
                              onClick={() => setTrackingForm((f) => ({ ...f, interviewType: isSelected ? '' : t.value }))}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                                isSelected
                                  ? 'bg-warning/15 border-warning/40 text-warning'
                                  : 'bg-base-200 border-base-300 text-base-content/60 hover:border-base-content/30'
                              }`}
                            >
                              <Icon className={`w-3.5 h-3.5 ${isSelected ? '' : t.color}`} />
                              {t.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {current.interviewDate ? (
                      <>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-base-content/50">Date :</span>
                          <span className="font-medium text-warning">{formatDateTime(current.interviewDate)}</span>
                        </div>
                        {current.interviewType && (
                          <div className="flex items-center gap-2 text-sm">
                            <span className="text-base-content/50">Type :</span>
                            <span className="badge badge-warning badge-outline badge-sm">{current.interviewType}</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-base-content/40 italic">Aucun entretien enregistré</p>
                    )}
                  </div>
                )}
              </div>

              {/* Offre section */}
              <div className="bg-base-300/30 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2 mb-1">
                  <Euro className="w-4 h-4 text-success" />
                  <h3 className="text-sm font-semibold">Offre & Salaire</h3>
                </div>
                {trackingEdit ? (
                  <div>
                    <label className="text-xs text-base-content/50 mb-1 block">Salaire proposé (texte libre)</label>
                    <input
                      type="text"
                      placeholder="Ex: 45k€/an, 3 800€/mois..."
                      value={trackingForm.offerSalary}
                      onChange={(e) => setTrackingForm((f) => ({ ...f, offerSalary: e.target.value }))}
                      className="input input-sm input-bordered w-full max-w-xs bg-base-100/70"
                    />
                  </div>
                ) : (
                  <div>
                    {current.offerSalary ? (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-base-content/50">Salaire :</span>
                        <span className="font-semibold text-success">{current.offerSalary}</span>
                      </div>
                    ) : (
                      <p className="text-sm text-base-content/40 italic">Aucun salaire enregistré</p>
                    )}
                  </div>
                )}
              </div>

              {/* Notes section */}
              <div className="bg-base-300/30 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2 mb-1">
                  <MessageSquare className="w-4 h-4 text-info" />
                  <h3 className="text-sm font-semibold">Notes & Retour</h3>
                </div>
                {trackingEdit ? (
                  <div>
                    <label className="text-xs text-base-content/50 mb-1 block">
                      Notes libres (feedback reçu, impressions, raison du refus...)
                    </label>
                    <textarea
                      rows={4}
                      placeholder="Ex: Entretien sympa, mais ils cherchent quelqu'un avec plus d'expérience en Kubernetes. Relancer dans 6 mois."
                      value={trackingForm.feedbackNote}
                      onChange={(e) => setTrackingForm((f) => ({ ...f, feedbackNote: e.target.value }))}
                      className="textarea textarea-bordered w-full text-sm bg-base-100/70 resize-none"
                    />
                  </div>
                ) : (
                  <div>
                    {current.feedbackNote ? (
                      <p className="text-sm text-base-content/80 leading-relaxed whitespace-pre-line">
                        {current.feedbackNote}
                      </p>
                    ) : (
                      <p className="text-sm text-base-content/40 italic">Aucune note enregistrée</p>
                    )}
                  </div>
                )}
              </div>

              {/* Applied date */}
              {current.appliedAt && (
                <div className="text-xs text-base-content/40 flex items-center gap-1.5">
                  <Check className="w-3 h-3 text-success" />
                  Candidature transmise le {formatDateTime(current.appliedAt)}
                </div>
              )}
            </div>
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

      {showRemoteLogin && current?.jobOffer?.source && (
        <RemoteLoginModal
          platform={current.jobOffer.source as any}
          targetUrl={current.sourceUrl}
          onClose={() => setShowRemoteLogin(false)}
          onLoggedIn={() => {
            setShowRemoteLogin(false);
            handleAction('markApplied', () => markApplied(id), 'Candidature marquée comme envoyée');
          }}
        />
      )}
    </AppShell>
  );
}
