'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useUpdatesStore } from '@/lib/updates-store';
import AppShell from '@/components/layout/app-shell';
import { BellRing, ArrowRight, Loader2, Quote } from 'lucide-react';

// Keyed by autoUpdateVerdict (NOT by application status) -- a 'confirmed'
// (needs_review -> applied: proof the candidature actually went through,
// not an outcome) and a genuinely ambiguous 'update' both used to leave
// status 'applied' and show the same "Réponse reçue" badge, which a real
// user found meaningless: two different situations collapsed into one
// unclear label with no way to check the claim. Older rows written before
// autoUpdateVerdict existed fall back to FALLBACK_VERDICT_BY_STATUS below.
const VERDICT_BADGE: Record<string, { label: string; description: string; badgeClass: string }> = {
  rejected: {
    label: 'Refusée',
    description: 'Refus détecté.',
    badgeClass: 'badge-error bg-error/15 text-error border-error/30',
  },
  interview: {
    label: 'Entretien',
    description: 'Proposition d\'entretien détectée.',
    badgeClass: 'badge-secondary bg-secondary/15 text-secondary border-secondary/30',
  },
  offer: {
    label: 'Offre reçue',
    description: 'Proposition d\'embauche détectée.',
    badgeClass: 'badge-success font-semibold',
  },
  confirmed: {
    label: 'Envoi confirmé',
    description: 'Candidature marquée "à vérifier" — une réponse reçue prouve qu\'elle a bien été envoyée (mais ne dit rien du résultat).',
    badgeClass: 'badge-info bg-info/15 text-info border-info/30',
  },
  update: {
    label: 'Réponse ambiguë — à vérifier',
    description: 'Un email lié à cette candidature est arrivé, mais ce n\'est ni un refus, ni un entretien, ni une offre clairs. Lisez l\'extrait ci-dessous.',
    badgeClass: 'badge-warning bg-warning/15 text-warning border-warning/30',
  },
};

const FALLBACK_VERDICT_BY_STATUS: Record<string, string> = {
  rejected: 'rejected',
  interview: 'interview',
  offer: 'offer',
  applied: 'update',
};

const SOURCE_LABEL: Record<string, string> = {
  gmail: 'Détecté par email (Gmail)',
  hellowork: 'Détecté sur HelloWork',
};

const FILTER_TABS: { key: string; label: string }[] = [
  { key: 'all', label: 'Toutes' },
  { key: 'rejected', label: 'Refusées' },
  { key: 'interview', label: 'Entretien' },
  { key: 'offer', label: 'Offre' },
  { key: 'confirmed', label: 'Envoi confirmé' },
  { key: 'update', label: 'Ambiguë' },
];

function verdictOf(app: { autoUpdateVerdict?: string | null; status: string }): string {
  return app.autoUpdateVerdict || FALLBACK_VERDICT_BY_STATUS[app.status] || 'update';
}

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

export default function UpdatesPage() {
  const { updates, loading, fetchList, markSeen } = useUpdatesStore();
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const app of updates) {
      const v = verdictOf(app);
      c[v] = (c[v] || 0) + 1;
    }
    return c;
  }, [updates]);

  const filtered = useMemo(
    () => (filter === 'all' ? updates : updates.filter((app) => verdictOf(app) === filter)),
    [updates, filter],
  );

  return (
    <AppShell>
      <div className="max-w-4xl mx-auto px-8 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight flex items-center gap-3">
            <BellRing className="w-7 h-7 text-primary" />
            Mises à jour
          </h1>
          <p className="text-base-content/50 mt-1">
            Réponses de recruteurs détectées automatiquement (email + statuts affichés sur les plateformes) — pas encore consultées.
          </p>
        </div>

        {!loading && !!updates.length && (
          <div className="flex flex-wrap gap-2 mb-6">
            {FILTER_TABS.map((tab) => {
              const count = tab.key === 'all' ? updates.length : counts[tab.key] || 0;
              if (tab.key !== 'all' && count === 0) return null;
              const active = filter === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setFilter(tab.key)}
                  className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                >
                  {tab.label}
                  <span className={`badge badge-sm ml-1 ${active ? 'badge-neutral' : 'badge-ghost'}`}>{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {loading && !updates.length && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-base-content/40" />
          </div>
        )}

        {!loading && !updates.length && (
          <div className="text-center py-20 text-base-content/40">
            <BellRing className="w-10 h-10 mx-auto mb-3 opacity-40" />
            Aucune nouvelle mise à jour pour le moment.
          </div>
        )}

        {!loading && !!updates.length && !filtered.length && (
          <div className="text-center py-20 text-base-content/40">
            Aucune mise à jour pour ce filtre.
          </div>
        )}

        <div className="space-y-3">
          {filtered.map((app) => {
            const verdictKey = app.autoUpdateVerdict || FALLBACK_VERDICT_BY_STATUS[app.status] || 'update';
            const verdict = VERDICT_BADGE[verdictKey] || { label: app.status, description: '', badgeClass: 'badge-ghost' };
            const sourceLabel = app.autoUpdateSource ? SOURCE_LABEL[app.autoUpdateSource] || app.autoUpdateSource : null;
            return (
              <div
                key={app.id}
                className="border border-base-300 rounded-xl p-5 flex items-start justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`badge badge-sm border gap-1 px-2.5 py-1 ${verdict.badgeClass}`}>
                      {verdict.label}
                    </span>
                    <span className="text-xs text-base-content/40">{formatDateTime(app.autoUpdateAt)}</span>
                  </div>
                  <p className="font-medium truncate">{app.jobTitle}</p>
                  <p className="text-sm text-base-content/60">{app.company}</p>
                  {verdict.description && (
                    <p className="text-xs text-base-content/50 mt-1.5">{verdict.description}</p>
                  )}
                  {app.autoUpdateSummary && (
                    <p className="text-sm text-base-content/70 mt-2 italic">« {app.autoUpdateSummary} »</p>
                  )}
                  {app.autoUpdateEvidence && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg bg-base-200/60 border border-base-300 px-3 py-2">
                      <Quote className="w-3.5 h-3.5 shrink-0 mt-0.5 text-base-content/40" />
                      <div className="min-w-0">
                        {sourceLabel && (
                          <p className="text-[11px] font-medium text-base-content/50 mb-0.5">{sourceLabel}</p>
                        )}
                        <p className="text-xs text-base-content/70 whitespace-pre-line break-words">{app.autoUpdateEvidence}</p>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <Link
                    href={`/candidatures/${app.id}`}
                    onClick={() => markSeen(app.id)}
                    className="btn btn-sm btn-primary gap-1"
                  >
                    Voir <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                  <button className="btn btn-sm btn-ghost" onClick={() => markSeen(app.id)}>
                    Marquer comme vue
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
