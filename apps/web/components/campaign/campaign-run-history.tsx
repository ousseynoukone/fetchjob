'use client';

import React, { useEffect, useState } from 'react';
import apiClient from '@/lib/api-client';
import { ChevronDown, ChevronRight, History, Loader2 } from 'lucide-react';

interface RunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  offersScanned: number;
  offersFiltered: number;
  applicationsPrepared: number;
  applicationsSent: number;
  error: string | null;
  statusCounts: Record<string, number>;
}

interface RunDetail extends RunSummary {
  totalApplications: number;
  failureReasons: { reason: string; count: number }[];
  bySource: { host: string; total: number; applied: number; needsReview: number }[];
}

function formatDateTime(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startedAt: string, finishedAt?: string | null) {
  if (!finishedAt) return 'en cours';
  const min = Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}

export default function CampaignRunHistory() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    apiClient
      .get('/api/campagne/runs')
      .then((res) => setRuns(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await apiClient.get(`/api/campagne/runs/${id}`);
      setDetail(res.data);
    } catch {
      // ignore — the panel just stays empty, nothing to recover
    } finally {
      setDetailLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-base-200 border border-base-300 rounded-2xl p-6 flex items-center gap-2 text-base-content/50">
        <Loader2 className="w-4 h-4 animate-spin" /> Chargement de l&apos;historique...
      </div>
    );
  }

  if (!runs.length) {
    return (
      <div className="bg-base-200 border border-base-300 rounded-2xl p-6 text-base-content/40 text-sm">
        Aucune campagne exécutée pour le moment.
      </div>
    );
  }

  return (
    <div className="bg-base-200 border border-base-300 rounded-2xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <History className="w-4 h-4 text-primary" />
        <p className="text-xs uppercase tracking-wider text-base-content/40 font-semibold">
          Historique des campagnes
        </p>
      </div>
      <div className="space-y-2">
        {runs.map((run) => {
          const applied = run.statusCounts.applied || 0;
          const needsReview = run.statusCounts.needs_review || 0;
          const toApply = run.statusCounts.to_apply || 0;
          const isExpanded = expandedId === run.id;
          return (
            <div key={run.id} className="bg-base-100 rounded-xl overflow-hidden">
              <button
                className="w-full flex items-center justify-between gap-4 p-4 text-left hover:bg-base-300/30 transition-colors"
                onClick={() => toggleExpand(run.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{formatDateTime(run.startedAt)}</span>
                    <span className="text-xs text-base-content/40">
                      · {formatDuration(run.startedAt, run.finishedAt)}
                    </span>
                    {!run.finishedAt && <span className="badge badge-primary badge-sm">en cours</span>}
                    {run.error && (
                      <span className="badge badge-error badge-sm" title={run.error}>
                        interrompue
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-base-content/40 mt-1">
                    {run.offersScanned} scannées → {run.offersFiltered} filtrées → {applied + needsReview + toApply}{' '}
                    candidat(e)s
                  </div>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <StatusPill label="envoyées" value={applied} color="success" />
                  <StatusPill label="à vérifier" value={needsReview} color="warning" />
                  <StatusPill label="en attente" value={toApply} color="neutral" />
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-base-content/30" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-base-content/30" />
                  )}
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-base-300 p-4">
                  {detailLoading ? (
                    <div className="flex items-center gap-2 text-base-content/40 text-sm py-4">
                      <Loader2 className="w-4 h-4 animate-spin" /> Chargement du détail...
                    </div>
                  ) : detail ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <p className="text-xs uppercase tracking-wider text-base-content/40 font-semibold mb-2">
                          Raisons des candidatures à vérifier
                        </p>
                        {detail.failureReasons.length ? (
                          <ul className="space-y-1.5">
                            {detail.failureReasons.map((f, idx) => (
                              <li key={idx} className="flex items-start gap-2 text-xs">
                                <span className="badge badge-sm badge-ghost shrink-0 mt-0.5">{f.count}</span>
                                <span className="text-base-content/60">{f.reason}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-xs text-base-content/30">Aucune — tout s&apos;est bien passé.</p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wider text-base-content/40 font-semibold mb-2">
                          Par plateforme
                        </p>
                        <ul className="space-y-1.5">
                          {detail.bySource.map((s, idx) => (
                            <li key={idx} className="flex items-center justify-between text-xs gap-3">
                              <span className="text-base-content/70 shrink-0">{s.host}</span>
                              <span className="text-base-content/40 text-right">
                                {s.total} · <span className="text-success">{s.applied} envoyées</span> ·{' '}
                                <span className="text-warning">{s.needsReview} à vérifier</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusPill({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: 'success' | 'warning' | 'neutral';
}) {
  if (!value) return null;
  const colorClass = color === 'success' ? 'text-success' : color === 'warning' ? 'text-warning' : 'text-base-content/40';
  return (
    <div className="text-center">
      <div className={`text-sm font-semibold ${colorClass}`}>{value}</div>
      <div className="text-[10px] text-base-content/30">{label}</div>
    </div>
  );
}
