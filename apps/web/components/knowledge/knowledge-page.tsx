'use client';

import React, { useEffect } from 'react';
import AppShell from '@/components/layout/app-shell';
import { useKnowledgeStore } from '@/lib/knowledge-store';
import { BookOpen, ExternalLink, RefreshCw, Code2 } from 'lucide-react';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function KnowledgePage() {
  const { status, items, loading, syncing, fetchStatus, fetchItems, sync } = useKnowledgeStore();

  useEffect(() => {
    fetchStatus();
    fetchItems();
  }, [fetchStatus, fetchItems]);

  return (
    <AppShell>
      <div className="max-w-3xl mx-auto px-8 py-10">
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Base de connaissance</h1>
            <p className="text-base-content/50 mt-1">
              Projets et expériences synchronisés (GitHub) utilisés pour enrichir l'adaptation de CV et
              lettres de motivation par offre.
            </p>
          </div>
          <button
            className="btn btn-primary btn-sm gap-1 shrink-0"
            onClick={() => sync()}
            disabled={!status?.githubConfigured || syncing}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            Synchroniser
          </button>
        </div>

        {status && (
          <div className="bg-base-200 border border-base-300 rounded-2xl p-5 mb-6 flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <Code2 className="w-4 h-4 text-base-content/40" />
              {status.githubConfigured ? (
                <span>
                  Connecté{status.githubUsername ? ` (${status.githubUsername})` : ''} · {status.itemCount} élément(s)
                  {status.lastSyncedAt ? ` · dernière synchro le ${formatDate(status.lastSyncedAt)}` : ''}
                </span>
              ) : (
                <span className="text-base-content/40">
                  Aucun token GitHub configuré — va dans Paramètres pour en ajouter un.
                </span>
              )}
            </div>
          </div>
        )}

        {loading && !items.length ? (
          <div className="flex justify-center py-20">
            <span className="loading loading-spinner loading-lg" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-16 text-base-content/40">
            <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p>Aucune connaissance synchronisée pour l'instant.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.id} className="bg-base-200 border border-base-300 rounded-2xl p-5">
                <div className="flex items-start justify-between gap-4 mb-2">
                  <div>
                    <p className="font-medium">{item.title}</p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-base-content/40">
                      <span className="badge badge-ghost badge-sm capitalize">{item.source}</span>
                      <span>synchronisé le {formatDate(item.syncedAt)}</span>
                    </div>
                  </div>
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-ghost btn-xs shrink-0"
                      title="Voir sur GitHub"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>

                {item.summary && <p className="text-sm text-base-content/70 mt-2">{item.summary}</p>}

                {item.skills.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {item.skills.map((skill) => (
                      <span key={skill} className="badge badge-outline badge-sm">
                        {skill}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
