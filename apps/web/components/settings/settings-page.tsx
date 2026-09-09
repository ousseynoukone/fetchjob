'use client';

import React, { useEffect, useState } from 'react';
import AppShell from '@/components/layout/app-shell';
import { useSettingsStore, SettingsStatus } from '@/lib/settings-store';
import { usePlatformCredentialsStore, SupportedPlatform } from '@/lib/platform-credentials-store';
import { useKnowledgeStore } from '@/lib/knowledge-store';
import { CheckCircle2, XCircle, Sparkles, Search, ShieldAlert, Trash2, BookOpen, RefreshCw, Mail } from 'lucide-react';

type FieldKey = keyof SettingsStatus;
type FieldSpec = { key: FieldKey; label: string; placeholder: string; type?: string };

const AI_FIELDS: FieldSpec[] = [
  { key: 'deepseekApiKey', label: 'Clé API DeepSeek', placeholder: 'sk-...' },
];

const SOURCE_FIELDS: FieldSpec[] = [
  { key: 'franceTravailClientId', label: 'France Travail — Identifiant client', placeholder: 'PAR_...' },
  { key: 'franceTravailClientSecret', label: 'France Travail — Clé secrète', placeholder: '••••••••' },
  { key: 'adzunaAppId', label: 'Adzuna — App ID', placeholder: '0346a69f' },
  { key: 'adzunaApiKey', label: 'Adzuna — API Key', placeholder: '••••••••' },
];

const NOTIFICATION_FIELDS: FieldSpec[] = [
  { key: 'notificationEmail', label: 'Adresse email de notification (destinataire)', placeholder: 'moi@example.com', type: 'email' },
  { key: 'smtpHost', label: 'Serveur SMTP', placeholder: 'smtp.gmail.com', type: 'text' },
  { key: 'smtpPort', label: 'Port SMTP', placeholder: '587', type: 'text' },
  { key: 'smtpUsername', label: 'Utilisateur SMTP (adresse d\'envoi)', placeholder: 'moi@gmail.com', type: 'email' },
  { key: 'smtpPassword', label: 'Mot de passe SMTP', placeholder: '••••••••' },
];

const PLATFORM_LABELS: Record<SupportedPlatform, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  france_travail: 'France Travail',
  hellowork: 'HelloWork',
};

function PlatformCredentialRow({ platform }: { platform: SupportedPlatform }) {
  const { items, saving, save, remove } = usePlatformCredentialsStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const item = items.find((i) => i.platform === platform);

  const handleSave = async () => {
    if (!email.trim() || !password.trim()) return;
    await save(platform, email.trim(), password);
    setEmail('');
    setPassword('');
  };

  return (
    <div className="border border-base-300 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium">{PLATFORM_LABELS[platform]}</span>
        {item?.configured ? (
          <div className="flex items-center gap-2">
            <span className="badge badge-success badge-sm gap-1">
              <CheckCircle2 className="w-3 h-3" /> {item.email}
            </span>
            <button className="btn btn-ghost btn-xs text-error" onClick={() => remove(platform)} title="Supprimer">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <span className="badge badge-ghost badge-sm gap-1">
            <XCircle className="w-3 h-3" /> Non configuré
          </span>
        )}
      </div>
      {item?.lastLoginError && (
        <p className="text-xs text-error mb-2">Dernière erreur de connexion : {item.lastLoginError}</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <input
          type="email"
          placeholder="email"
          className="input input-bordered input-sm"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
        />
        <input
          type="password"
          placeholder="mot de passe"
          className="input input-bordered input-sm"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
        />
      </div>
      <button
        className="btn btn-outline btn-xs mt-2"
        onClick={handleSave}
        disabled={saving || !email.trim() || !password.trim()}
      >
        {item?.configured ? 'Remplacer' : 'Enregistrer'}
      </button>
    </div>
  );
}

function KnowledgeBaseSection() {
  const { status, saving, syncing, fetchStatus, saveGithubToken, removeGithubToken, sync } = useKnowledgeStore();
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleSave = async () => {
    if (!token.trim()) return;
    await saveGithubToken(token.trim(), username.trim() || undefined);
    setToken('');
    setUsername('');
  };

  return (
    <div className="bg-base-200 border border-base-300 rounded-2xl p-6">
      <div className="flex items-center gap-2 mb-2">
        <BookOpen className="w-4 h-4 text-primary" />
        <h2 className="font-semibold">Base de connaissance</h2>
      </div>
      <p className="text-xs text-base-content/40 mb-4">
        Synchronise vos dépôts GitHub (privés inclus) pour enrichir l'adaptation de CV et lettres de
        motivation par offre. Nécessite un token d'accès personnel avec le scope <code>repo</code>.
      </p>

      <div className="flex items-center justify-between mb-3 text-sm">
        <span>
          {status?.githubConfigured ? (
            <span className="badge badge-success badge-sm gap-1">
              <CheckCircle2 className="w-3 h-3" /> Connecté{status.githubUsername ? ` (${status.githubUsername})` : ''}
            </span>
          ) : (
            <span className="badge badge-ghost badge-sm gap-1">
              <XCircle className="w-3 h-3" /> Non connecté
            </span>
          )}
        </span>
        {status?.githubConfigured && (
          <button className="btn btn-ghost btn-xs text-error" onClick={() => removeGithubToken()}>
            <Trash2 className="w-3.5 h-3.5" /> Supprimer
          </button>
        )}
      </div>

      {status && (
        <p className="text-xs text-base-content/40 mb-3">
          {status.itemCount} élément(s) en base
          {status.lastSyncedAt ? ` · dernière synchro le ${new Date(status.lastSyncedAt).toLocaleString('fr-FR')}` : ''}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 mb-2">
        <input
          type="text"
          placeholder="Nom d'utilisateur GitHub (optionnel)"
          className="input input-bordered input-sm"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
        />
        <input
          type="password"
          placeholder="Personal Access Token (scope repo)"
          className="input input-bordered input-sm"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="flex gap-2">
        <button className="btn btn-outline btn-xs" onClick={handleSave} disabled={saving || !token.trim()}>
          {status?.githubConfigured ? 'Remplacer le token' : 'Enregistrer le token'}
        </button>
        <button
          className="btn btn-primary btn-xs gap-1"
          onClick={() => sync()}
          disabled={!status?.githubConfigured || syncing}
        >
          <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
          Synchroniser maintenant
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { status, loading, saving, lastSavedAt, fetchStatus, update } = useSettingsStore();
  const { fetchStatus: fetchCredentials } = usePlatformCredentialsStore();
  const [form, setForm] = useState<Partial<Record<FieldKey, string>>>({});
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    fetchStatus();
    fetchCredentials();
  }, [fetchStatus, fetchCredentials]);

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

  const renderField = ({ key, label, placeholder, type }: FieldSpec) => (
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
        type={type || 'password'}
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

            <div className="bg-base-200 border border-base-300 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <Mail className="w-4 h-4 text-primary" />
                <h2 className="font-semibold">Alertes par email</h2>
              </div>
              <p className="text-xs text-base-content/40 mb-4">
                Reçoit un email quand l'auto-apply rencontre une nouvelle question personnalisée
                (page "Questions"). Les deux champs sont nécessaires pour que l'envoi fonctionne.
              </p>
              <div className="space-y-4">{NOTIFICATION_FIELDS.map(renderField)}</div>
            </div>

            <button
              className="btn btn-primary gap-2"
              onClick={handleSave}
              disabled={saving || Object.values(form).every((v) => !v?.trim())}
            >
              {saving && <span className="loading loading-spinner loading-xs" />}
              Enregistrer
            </button>

            <div className="bg-base-200 border border-base-300 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-2">
                <ShieldAlert className="w-4 h-4 text-warning" />
                <h2 className="font-semibold">Comptes externes (auto-apply)</h2>
              </div>
              <p className="text-xs text-base-content/40 mb-4">
                Identifiants utilisés par le bot pour se connecter et postuler à votre place en mode
                auto-apply. Stockés chiffrés. LinkedIn et Indeed interdisent l'automatisation dans leurs
                CGU — un usage abusif peut entraîner une suspension de compte. En cas de CAPTCHA ou de
                vérification en deux étapes, le bot abandonne la candidature (statut "à vérifier") plutôt
                que de tenter de la contourner.
              </p>
              <div className="space-y-3">
                <PlatformCredentialRow platform="linkedin" />
                <PlatformCredentialRow platform="indeed" />
                <PlatformCredentialRow platform="france_travail" />
                <PlatformCredentialRow platform="hellowork" />
              </div>
            </div>

            <KnowledgeBaseSection />
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
