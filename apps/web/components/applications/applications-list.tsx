'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApplicationsStore } from '@/lib/applications-store';
import AppShell from '@/components/layout/app-shell';
import AddOfferModal from './add-offer-modal';
import { MapPin, Building2, Plus, Trash2, ChevronDown } from 'lucide-react';

const TABS = [
  { id: '', label: 'Toutes' },
  { id: 'to_apply', label: 'À postuler' },
  { id: 'applied', label: 'Envoyées' },
  { id: 'interview', label: 'Entretien' },
  { id: 'offer', label: 'Offre' },
  { id: 'rejected', label: 'Refusées' },
  { id: 'ignored', label: 'Ignorées' },
];

const STATUS_STYLE: Record<string, string> = {
  to_apply: 'badge-info',
  applied: 'badge-primary',
  interview: 'badge-warning',
  offer: 'badge-success',
  rejected: 'badge-error',
  ignored: 'badge-ghost',
};

function scoreColor(score: number) {
  if (score >= 80) return 'text-success';
  if (score >= 60) return 'text-warning';
  return 'text-base-content/40';
}

export default function ApplicationsList() {
  const { applications, loading, fetchList, removeAll } = useApplicationsStore();
  const [tab, setTab] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  useEffect(() => {
    fetchList(tab || undefined);
  }, [tab, fetchList]);

  const handleClearToApply = async () => {
    if (!confirm("Supprimer toutes les candidatures au statut \"à postuler\" ? Cette action est irréversible.")) return;
    await removeAll('to_apply');
  };

  const handleClearAll = async () => {
    if (!confirm('Supprimer TOUTES les candidatures, quel que soit leur statut ? Cette action est irréversible.')) return;
    await removeAll();
  };

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto px-8 py-10">
        <div className="flex justify-between items-start mb-8">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Candidatures</h1>
            <p className="text-base-content/50 mt-1">
              Candidatures préparées automatiquement par vos campagnes, ou ajoutées manuellement
            </p>
          </div>
          <div className="flex gap-2">
            {applications.length > 0 && (
              <div className="dropdown dropdown-end">
                <label tabIndex={0} className="btn btn-outline btn-sm gap-1.5">
                  <Trash2 className="w-4 h-4" /> Nettoyer <ChevronDown className="w-3.5 h-3.5" />
                </label>
                <ul tabIndex={0} className="dropdown-content menu z-10 mt-2 p-1.5 shadow-xl bg-base-200 border border-base-300 rounded-xl w-64">
                  <li>
                    <button onClick={handleClearToApply}>Supprimer les "à postuler"</button>
                  </li>
                  <li>
                    <button onClick={handleClearAll} className="text-error">
                      Tout supprimer
                    </button>
                  </li>
                </ul>
              </div>
            )}
            <button className="btn btn-primary btn-sm gap-2" onClick={() => setShowAddModal(true)}>
              <Plus className="w-4 h-4" /> Ajouter une offre
            </button>
          </div>
        </div>

        {showAddModal && <AddOfferModal onClose={() => setShowAddModal(false)} />}

        <div className="flex gap-1 mb-6 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                tab === t.id
                  ? 'bg-primary/15 text-primary'
                  : 'text-base-content/50 hover:text-base-content hover:bg-base-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <span className="loading loading-spinner loading-lg" />
          </div>
        ) : applications.length === 0 ? (
          <div className="bg-base-200 border border-base-300 rounded-2xl p-12 text-center">
            <p className="text-base-content/50">
              Aucune candidature pour le moment. Lancez une campagne, ou ajoutez une offre manuellement.
            </p>
            <div className="flex justify-center gap-2 mt-4">
              <Link href="/campagne" className="btn btn-primary btn-sm">
                Configurer une campagne
              </Link>
              <button className="btn btn-outline btn-sm" onClick={() => setShowAddModal(true)}>
                Ajouter une offre
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {applications.map((app) => (
              <Link
                key={app.id}
                href={`/candidatures/${app.id}`}
                className="bg-base-200 border border-base-300 rounded-2xl p-5 hover:border-primary/40 transition-colors"
              >
                <div className="flex justify-between items-start mb-3">
                  <div className={`text-2xl font-bold ${scoreColor(app.matchScore)}`}>{app.matchScore}</div>
                  <span className={`badge ${STATUS_STYLE[app.status] || 'badge-ghost'} badge-sm`}>
                    {app.status.replace('_', ' ')}
                  </span>
                </div>
                <h3 className="font-semibold leading-snug">{app.jobTitle}</h3>
                <div className="flex items-center gap-1.5 text-sm text-base-content/50 mt-1">
                  <Building2 className="w-3.5 h-3.5" />
                  {app.company}
                </div>
                {app.location && (
                  <div className="flex items-center gap-1.5 text-sm text-base-content/40 mt-0.5">
                    <MapPin className="w-3.5 h-3.5" />
                    {app.location}
                  </div>
                )}
                <div className="mt-3 text-xs text-base-content/30 capitalize">{app.jobOffer?.source?.replace('_', ' ')}</div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
