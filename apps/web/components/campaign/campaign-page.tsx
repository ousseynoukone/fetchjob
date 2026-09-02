'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useCampaignStore } from '@/lib/campaign-store';
import AppShell from '@/components/layout/app-shell';
import { Play, Pause, Loader2, Terminal } from 'lucide-react';

const CONTRACT_TYPES = ['CDI', 'CDD', 'Freelance', 'Stage', 'Alternance'];
const SOURCES = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'hellowork', label: 'HelloWork' },
  { id: 'indeed', label: 'Indeed' },
  { id: 'france_travail', label: 'France Travail' },
  { id: 'adzuna', label: 'Adzuna' },
  { id: 'remotive', label: 'Remotive (remote)' },
  { id: 'arbeitnow', label: 'Arbeitnow' },
  { id: 'jobicy', label: 'Jobicy (remote)' },
  { id: 'the_muse', label: 'The Muse' },
];

export default function CampaignPage() {
  const {
    campaign,
    latestRun,
    loading,
    saving,
    running,
    fetchCampaign,
    updateCampaign,
    runCampaign,
    pauseCampaign,
    fetchLatestRun,
  } = useCampaignStore();

  const [form, setForm] = useState({
    jobTitle: '',
    location: '',
    remote: false,
    contractTypes: [] as string[],
    keywordsText: '',
    excludeKeywordsText: '',
    maxAgeMonths: 0,
    maxApplicationsPerDay: 10,
    minMatchScore: 60,
    actionMode: 'prepare_only',
    sources: [] as string[],
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCampaign();
    fetchLatestRun();
  }, [fetchCampaign, fetchLatestRun]);

  useEffect(() => {
    if (!campaign) return;
    setForm({
      jobTitle: campaign.jobTitle || '',
      location: campaign.location || '',
      remote: campaign.remote,
      contractTypes: campaign.contractTypes || [],
      keywordsText: (campaign.keywords || []).join(', '),
      excludeKeywordsText: (campaign.excludeKeywords || []).join(', '),
      maxAgeMonths: campaign.maxAgeMonths ?? 0,
      maxApplicationsPerDay: campaign.maxApplicationsPerDay,
      minMatchScore: campaign.minMatchScore,
      actionMode: campaign.actionMode,
      sources: campaign.sources || [],
    });
  }, [campaign]);

  useEffect(() => {
    if (running) {
      pollRef.current = setInterval(fetchLatestRun, 2500);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [running, fetchLatestRun]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [latestRun?.logs?.length]);

  const toggleArrayValue = (key: 'contractTypes' | 'sources', value: string) => {
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
    }));
  };

  const handleSave = async () => {
    await updateCampaign({
      jobTitle: form.jobTitle,
      location: form.location,
      remote: form.remote,
      contractTypes: form.contractTypes,
      keywords: form.keywordsText.split(',').map((k) => k.trim()).filter(Boolean),
      excludeKeywords: form.excludeKeywordsText.split(',').map((k) => k.trim()).filter(Boolean),
      maxAgeMonths: Number(form.maxAgeMonths),
      maxApplicationsPerDay: Number(form.maxApplicationsPerDay),
      minMatchScore: Number(form.minMatchScore),
      actionMode: form.actionMode as 'prepare_only' | 'auto_apply',
      sources: form.sources,
    });
  };

  const handleRun = async () => {
    await handleSave();
    await runCampaign();
  };

  if (loading && !campaign) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-screen">
          <span className="loading loading-spinner loading-lg" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto px-8 py-10">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Campagne</h1>
            <p className="text-base-content/50 mt-1">
              Recherche automatisée : scraping des offres, matching et préparation par l'IA
            </p>
          </div>
          <div className="flex gap-2">
            {running ? (
              <button className="btn btn-outline gap-2" onClick={pauseCampaign}>
                <Pause className="w-4 h-4" /> Pause
              </button>
            ) : (
              <button className="btn btn-primary gap-2" disabled={saving} onClick={handleRun}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Lancer maintenant
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6 items-start">
          {/* Settings */}
          <div className="bg-base-200 border border-base-300 rounded-2xl p-6 space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Poste recherché">
                <input
                  className="input input-bordered w-full"
                  placeholder="Développeur Full Stack"
                  value={form.jobTitle}
                  onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))}
                />
              </Field>
              <Field label="Localisation">
                <input
                  className="input input-bordered w-full"
                  placeholder="Paris, France"
                  value={form.location}
                  onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                />
              </Field>
            </div>

            <Field label="Mots-clés (séparés par des virgules)">
              <input
                className="input input-bordered w-full"
                placeholder="React, Node.js, TypeScript"
                value={form.keywordsText}
                onChange={(e) => setForm((f) => ({ ...f, keywordsText: e.target.value }))}
              />
            </Field>

            <Field label="Mots-clés à écarter (séparés par des virgules)">
              <input
                className="input input-bordered w-full"
                placeholder="stage, alternance"
                value={form.excludeKeywordsText}
                onChange={(e) => setForm((f) => ({ ...f, excludeKeywordsText: e.target.value }))}
              />
            </Field>

            <label className="flex items-center gap-3 cursor-pointer w-fit">
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={form.remote}
                onChange={(e) => setForm((f) => ({ ...f, remote: e.target.checked }))}
              />
              <span className="text-sm">Télétravail</span>
            </label>

            <Field label="Type de contrat">
              <div className="flex flex-wrap gap-2">
                {CONTRACT_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleArrayValue('contractTypes', type)}
                    className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                      form.contractTypes.includes(type)
                        ? 'bg-primary/15 border-primary text-primary'
                        : 'border-base-300 text-base-content/60 hover:border-base-content/30'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Sources de recherche">
              <div className="flex flex-wrap gap-2">
                {SOURCES.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => toggleArrayValue('sources', source.id)}
                    className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                      form.sources.includes(source.id)
                        ? 'bg-primary/15 border-primary text-primary'
                        : 'border-base-300 text-base-content/60 hover:border-base-content/30'
                    }`}
                  >
                    {source.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-base-content/40 mt-2">
                Les offres sont récupérées automatiquement depuis les plateformes sélectionnées (LinkedIn, HelloWork, Indeed, France Travail, Adzuna, etc.).
              </p>
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label={`Score minimum de matching: ${form.minMatchScore}`}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  className="range range-primary range-sm"
                  value={form.minMatchScore}
                  onChange={(e) => setForm((f) => ({ ...f, minMatchScore: Number(e.target.value) }))}
                />
              </Field>
              <Field label="Max candidatures / jour">
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="input input-bordered w-full"
                  value={form.maxApplicationsPerDay}
                  onChange={(e) => setForm((f) => ({ ...f, maxApplicationsPerDay: Number(e.target.value) }))}
                />
              </Field>
            </div>

            <Field label="Fraîcheur : publiées depuis moins de (mois, 0 = illimité)">
              <input
                type="number"
                min={0}
                max={60}
                className="input input-bordered w-full max-w-[160px]"
                value={form.maxAgeMonths}
                onChange={(e) => setForm((f) => ({ ...f, maxAgeMonths: Number(e.target.value) }))}
              />
            </Field>

            <Field label="Mode d'action">
              <div className="flex gap-2">
                <ModeButton
                  active={form.actionMode === 'prepare_only'}
                  onClick={() => setForm((f) => ({ ...f, actionMode: 'prepare_only' }))}
                  label="Préparer seulement"
                  description="Les candidatures sont préparées, vous postulez vous-même."
                />
                <ModeButton
                  active={form.actionMode === 'auto_apply'}
                  onClick={() => setForm((f) => ({ ...f, actionMode: 'auto_apply' }))}
                  label="Auto-apply"
                  description="Non implémenté : la soumission automatique reste désactivée."
                />
              </div>
            </Field>

            <button className="btn btn-outline btn-sm" disabled={saving} onClick={handleSave}>
              {saving ? 'Enregistrement...' : 'Enregistrer les réglages'}
            </button>
          </div>

          {/* Status / logs */}
          <div className="space-y-4">
            <div className="bg-base-200 border border-base-300 rounded-2xl p-5">
              <p className="text-xs uppercase tracking-wider text-base-content/40 font-semibold mb-3">
                Statistiques
              </p>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Stat label="Offres scannées" value={campaign?.totalOffersScanned ?? 0} />
                <Stat label="Offres filtrées" value={campaign?.totalOffersFiltered ?? 0} />
                <Stat label="Candidatures préparées" value={campaign?.totalApplicationsPrepared ?? 0} />
                <Stat label="Candidatures envoyées" value={campaign?.totalApplicationsSent ?? 0} />
              </div>
            </div>

            <div className="bg-base-200 border border-base-300 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <Terminal className="w-4 h-4 text-primary" />
                <p className="text-xs uppercase tracking-wider text-base-content/40 font-semibold">
                  Journal d'exécution {running && <span className="text-primary">(en cours)</span>}
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
                  <p className="text-base-content/30">Aucune exécution pour le moment.</p>
                )}
                {latestRun?.error && <p className="text-error">Erreur: {latestRun.error}</p>}
                <div ref={logEndRef} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm font-medium text-base-content/70 mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-base-content/40">{label}</div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  description,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 text-left p-3 rounded-xl border transition-colors ${
        active ? 'bg-primary/15 border-primary' : 'border-base-300 hover:border-base-content/30'
      }`}
    >
      <p className={`text-sm font-medium ${active ? 'text-primary' : ''}`}>{label}</p>
      <p className="text-xs text-base-content/40 mt-0.5">{description}</p>
    </button>
  );
}
