'use client';

import React, { useEffect, useRef } from 'react';
import { useVerificationStore } from '@/lib/verification-store';
import AppShell from '@/components/layout/app-shell';
import { ShieldCheck, Play, Loader2, Terminal } from 'lucide-react';

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-base-content/50">{label}</p>
    </div>
  );
}

export default function VerificationPage() {
  const { latestRun, history, running, fetchLatestRun, fetchHistory, runVerification, connectStream } =
    useVerificationStore();

  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchLatestRun();
    fetchHistory();
  }, [fetchLatestRun, fetchHistory]);

  useEffect(() => {
    const disconnect = connectStream();
    return disconnect;
  }, [connectStream]);

  useEffect(() => {
    // See campaign-page.tsx's identical fix: `block: 'nearest'` keeps this
    // scroll inside the log panel's own overflow container instead of
    // dragging the whole page down past it on every new log line.
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [latestRun?.logs?.length]);

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto px-8 py-10">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Vérification</h1>
            <p className="text-base-content/50 mt-1">
              Revisite chaque candidature marquée « envoyée » sur LinkedIn, Indeed, France Travail et HelloWork pour
              confirmer que la plateforme l'a bien enregistrée — indépendamment de ce que le formulaire a affiché au
              moment de l'envoi.
            </p>
          </div>
          <button className="btn btn-primary gap-2" disabled={running} onClick={runVerification}>
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            Lancer une vérification
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6 items-start">
          <div className="bg-base-200 border border-base-300 rounded-2xl p-5">
            <p className="text-xs uppercase tracking-wider text-base-content/40 font-semibold mb-3">
              Historique des vérifications
            </p>
            {history.length ? (
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>Démarrée</th>
                      <th>Vérifiées</th>
                      <th>Confirmées</th>
                      <th>Non confirmées</th>
                      <th>Statut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((run) => (
                      <tr key={run.id}>
                        <td>{new Date(run.startedAt).toLocaleString('fr-FR')}</td>
                        <td>{run.checked}</td>
                        <td className="text-success">{run.confirmed}</td>
                        <td className="text-warning">{run.unconfirmed}</td>
                        <td>{run.error ? <span className="text-error">Erreur</span> : run.finishedAt ? 'Terminée' : 'En cours'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-base-content/50">Aucune vérification lancée pour l'instant.</p>
            )}
          </div>

          <div className="space-y-4">
            <div className="bg-base-200 border border-base-300 rounded-2xl p-5">
              <p className="text-xs uppercase tracking-wider text-base-content/40 font-semibold mb-3">
                Dernière vérification
              </p>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <Stat label="Vérifiées" value={latestRun?.checked ?? 0} />
                <Stat label="Confirmées" value={latestRun?.confirmed ?? 0} />
                <Stat label="Non confirmées" value={latestRun?.unconfirmed ?? 0} />
              </div>
            </div>

            <div className="bg-base-200 border border-base-300 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <Terminal className="w-4 h-4 text-primary" />
                <p className="text-xs uppercase tracking-wider text-base-content/40 font-semibold">
                  Journal {running && <span className="text-primary">(en cours)</span>}
                </p>
              </div>
              <div className="bg-base-100 rounded-xl p-3 h-64 overflow-y-auto font-mono text-xs space-y-1">
                {latestRun?.logs?.length ? (
                  latestRun.logs.map((log, idx) => (
                    <p key={idx} className="text-base-content/70">
                      {log}
                    </p>
                  ))
                ) : (
                  <p className="text-base-content/40">Aucune vérification en cours.</p>
                )}
                <div ref={logEndRef} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
