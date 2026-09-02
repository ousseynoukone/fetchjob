'use client';

import React, { useEffect, useState } from 'react';
import AppShell from '@/components/layout/app-shell';
import { useSettingsStore, SettingsStatus } from '@/lib/settings-store';
import { CheckCircle2, XCircle, Sparkles, Search } from 'lucide-react';

type FieldKey = keyof SettingsStatus;

const AI_FIELDS: { key: FieldKey; label: string; placeholder: string }[] = [
  { key: 'deepseekApiKey', label: 'Clé API DeepSeek', placeholder: 'sk-...' },
];

const SOURCE_FIELDS: { key: FieldKey; label: string; placeholder: string }[] = [
  { key: 'franceTravailClientId', label: 'France Travail — Identifiant client', placeholder: 'PAR_...' },
  { key: 'franceTravailClientSecret', label: 'France Travail — Clé secrète', placeholder: '••••••••' },
  { key: 'adzunaAppId', label: 'Adzuna — App ID', placeholder: '0346a69f' },
  { key: 'adzunaApiKey', label: 'Adzuna — API Key', placeholder: '••••••••' },
];

export default function SettingsPage() {
  const { status, loading, saving, lastSavedAt, fetchStatus, update } = useSettingsStore();
  const [form, setForm] = useState<Partial<Record<FieldKey, string>>>({});
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!lastSavedAt) return;
    setForm({});
    setShowToast(true);
    const timer = setTimeout(() => setShowToast(false), 2500);
    return () => clearTimeout(timer);
  }, [lastSavedAt]);

  const handleSave = async () => {
    const nonEmpty = Object.fromEntries(Object.entries(form).filter(([, v]) => v && v.trim()));
    if (Object.keys(nonEmpty).length === 0) return;
    await update(nonEmpty);
  };

  const renderField = ({ key, label, placeholder }: { key: FieldKey; label: string; placeholder: string }) => (
    <div className="form-control" key={key}>
      <label className="label">
        <span className="label-text">{label}</span>
        {status && (
          <span className={`badge badge-sm gap-1 ${status[key] ? 'badge-success' : 'badge-ghost'}`}>
            {status[key] ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
            {status[key] ? 'Configuré' : 'Non configuré'}
          </span>
        )}
      </label>
      <input
        type="password"
        placeholder={placeholder}
        className="input input-bordered"
        value={form[key] || ''}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        autoComplete="off"
      />
    </div>
  );

  return (
    <AppShell>
      <div className="max-w-2xl mx-auto px-8 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Paramètres</h1>
          <p className="text-base-content/50 mt-1">
            Clés API utilisées par l'application. Laissez un champ vide pour ne pas le modifier —
            chaque clé n'est jamais réaffichée une fois enregistrée.
          </p>
        </div>

        {loading && !status ? (
          <div className="flex justify-center py-20">
            <span className="loading loading-spinner loading-lg" />
          </div>
        ) : (
          <div className="space-y-6">
            <div className="bg-base-200 border border-base-300 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="w-4 h-4 text-primary" />
                <h2 className="font-semibold">Intelligence artificielle</h2>
              </div>
              <p className="text-xs text-base-content/40 mb-4">
                Utilisée pour adapter votre CV, générer les lettres de motivation et l'analyse IA de
                chaque offre.
              </p>
              <div className="space-y-4">{AI_FIELDS.map(renderField)}</div>
            </div>

            <div className="bg-base-200 border border-base-300 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <Search className="w-4 h-4 text-primary" />
                <h2 className="font-semibold">Sources d'offres</h2>
              </div>
              <p className="text-xs text-base-content/40 mb-4">
                Utilisées par les campagnes pour scanner de vraies offres. Remotive ne nécessite pas
                de clé.
              </p>
              <div className="space-y-4">{SOURCE_FIELDS.map(renderField)}</div>
            </div>

            <button
              className="btn btn-primary gap-2"
              onClick={handleSave}
              disabled={saving || Object.values(form).every((v) => !v?.trim())}
            >
              {saving && <span className="loading loading-spinner loading-xs" />}
              Enregistrer
            </button>
          </div>
        )}
      </div>

      {showToast && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-sm font-medium bg-base-100 border border-base-300">
            <CheckCircle2 className="w-4 h-4 text-success" /> Paramètres enregistrés
          </div>
        </div>
      )}
    </AppShell>
  );
}
