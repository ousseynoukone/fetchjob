'use client';

import React, { useEffect, useState } from 'react';
import AppShell from '@/components/layout/app-shell';
import { useSettingsStore, SettingsStatus } from '@/lib/settings-store';
import { usePlatformCredentialsStore, SupportedPlatform } from '@/lib/platform-credentials-store';
import { useKnowledgeStore } from '@/lib/knowledge-store';
import RemoteLoginModal from './remote-login-modal';
import { CheckCircle2, XCircle, Sparkles, Search, ShieldAlert, Trash2, BookOpen, RefreshCw, Mail, MonitorPlay } from 'lucide-react';

type FieldKey = keyof SettingsStatus;
type FieldSpec = { key: FieldKey; label: string; placeholder: string; type?: string };

const AI_FIELDS: FieldSpec[] = [
  { key: 'deepseekApiKey', label: 'Clé API DeepSeek', placeholder: 'sk-...' },
  {
    key: 'autoApplyMaxAiCalls',
    label: "Auto-apply — appels IA max. par candidature (0 pour désactiver)",
    placeholder: '3',
    type: 'number',
  },
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
  {
    key: 'digestIntervalHours',
    label: 'Résumé des candidatures envoyées — toutes les X heures',
    placeholder: '4',
    type: 'number',
  },
];

const PLATFORM_LABELS: Record<SupportedPlatform, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  france_travail: 'France Travail',
  hellowork: 'HelloWork',
  welcome_to_the_jungle: 'Welcome to the Jungle',
  apec: 'APEC',
  gmail: 'Gmail',
};

// Only LinkedIn's applier ever attempts an automatic email/password login
// (linkedin.applier.ts's performDirectLogin) — Indeed, France Travail and
// HelloWork all run a real bot-detection check that blocks a headless
// browser (confirmed live on HelloWork: FriendlyCaptcha), so their appliers
// never even read a stored password; they only ever reuse a session
// established once via `npm run establish-session`. The form below used to
// show the same "enter your password, the bot logs in automatically" copy
// for all four platforms — which was simply false for three of them, and
// is exactly what led a real user to enter a HelloWork password expecting
// auto-login, only to keep getting "session expired" regardless.
const AUTO_LOGIN_PLATFORMS = new Set<SupportedPlatform>([
  'linkedin',
  'france_travail',
  'hellowork',
  'welcome_to_the_jungle',
  'apec',
  'gmail',
]);

const PLATFORM_NOTES: Partial<Record<SupportedPlatform, string>> = {
  indeed: "Indeed bloque les connexions venues d'un serveur (protection Cloudflare). La reprise en main via \"Se connecter\" est souvent le seul chemin qui marche.",
  hellowork: "HelloWork fait passer un contrôle anti-robot (FriendlyCaptcha) à la connexion — à valider toi-même dans la fenêtre \"Se connecter\".",
  france_travail: "Identifiant France Travail : votre identifiant numérique. Reconnexion automatique avec récupération directe du code de validation depuis Gmail.",
  welcome_to_the_jungle: "Beaucoup d'annonces renvoient vers l'outil de recrutement de l'employeur : l'envoi automatique ne couvre que celles hébergées directement par Welcome to the Jungle.",
  apec: "Connexion et reconnexion 100% automatiques avec votre adresse email et mot de passe.",
  gmail: "Permet de relever automatiquement les codes de sécurité (ex: code à 8 chiffres de France Travail). Vous pouvez vous connecter via le navigateur intégré, ou renseigner un mot de passe d'application Google (généré sur myaccount.google.com/apppasswords).",
};

// Gmail supports both remote login browser and entering a Google App Password directly
const MANUAL_ONLY_PLATFORMS = new Set<SupportedPlatform>([]);

function PlatformCredentialRow({ platform }: { platform: SupportedPlatform }) {
  const { items, remove, saveCredentials, fetchStatus } = usePlatformCredentialsStore();
  const item = items.find((i) => i.platform === platform);
  const [isEditing, setIsEditing] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sessionState, setSessionState] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showRemoteLogin, setShowRemoteLogin] = useState(false);
  const supportsAutoLogin = AUTO_LOGIN_PLATFORMS.has(platform);
  const isManualOnly = MANUAL_ONLY_PLATFORMS.has(platform);

  const isGmail = platform === 'gmail';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() && !sessionState.trim()) return;
    setSaving(true);
    const ok = await saveCredentials(
      platform,
      email.trim(),
      supportsAutoLogin ? password || undefined : undefined,
      sessionState.trim() || undefined,
    );
    setSaving(false);
    if (ok) {
      setIsEditing(false);
      setPassword('');
      setSessionState('');
    }
  };

  if (isGmail) {
    return (
      <div className="border border-base-300 rounded-xl p-4 bg-base-100/50">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">Gmail (Passerelle 2FA & Codes de sécurité)</span>
          </div>
          {item?.configured ? (
            <div className="flex items-center gap-2">
              <span className="badge badge-success badge-sm gap-1 text-xs">
                <CheckCircle2 className="w-3 h-3" /> Connecté ({item.email})
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-xs text-base-content/60 hover:text-primary"
                onClick={() => setIsEditing(!isEditing)}
              >
                {isEditing ? 'Fermer' : 'Modifier'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs text-base-content/60 hover:text-primary gap-1"
                onClick={() => setShowRemoteLogin(true)}
                title="Se connecter via navigateur"
              >
                <MonitorPlay className="w-3.5 h-3.5" /> Navigateur
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs text-error"
                onClick={() => remove(platform)}
                title="Supprimer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="badge badge-ghost badge-sm gap-1 text-xs text-base-content/60">
                <XCircle className="w-3 h-3" /> Non configuré
              </span>
              <button
                type="button"
                className="btn btn-primary btn-xs gap-1"
                onClick={() => setIsEditing(true)}
              >
                Configurer App Password
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs gap-1"
                onClick={() => setShowRemoteLogin(true)}
              >
                <MonitorPlay className="w-3.5 h-3.5" /> Navigateur
              </button>
            </div>
          )}
        </div>

        <p className="text-xs text-base-content/60 mb-2">
          Permet au robot de relever automatiquement et instantanément les codes de sécurité à 8 chiffres (France Travail, Indeed, APEC, LinkedIn...) sans intervention humaine.
        </p>

        {isEditing && (
          <form onSubmit={handleSubmit} className="mt-3 pt-3 border-t border-base-300 space-y-3">
            <div className="text-xs text-base-content/70 bg-base-200 rounded-lg p-3 leading-relaxed space-y-1">
              <div className="font-medium text-base-content">Comment obtenir votre mot de passe d'application Google :</div>
              <div>1. Rendez-vous sur <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-primary hover:underline">myaccount.google.com/apppasswords</a></div>
              <div>2. Connectez-vous à votre compte Google et sélectionnez <strong>Autre (nom personnalisé)</strong>, tapez <em>Findurjob</em>.</div>
              <div>3. Google vous affiche un mot de passe de 16 lettres (ex : <code>ecxb nshk jckn xted</code>) : collez-le ci-dessous.</div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="label py-0.5">
                  <span className="label-text text-xs">Adresse Gmail</span>
                </label>
                <input
                  type="email"
                  required
                  placeholder="votre.adresse@gmail.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input input-sm input-bordered w-full"
                />
              </div>
              <div>
                <label className="label py-0.5">
                  <span className="label-text text-xs">Mot de passe d'application (16 lettres)</span>
                </label>
                <input
                  type="password"
                  required={!item?.configured}
                  placeholder="••••••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input input-sm input-bordered w-full font-mono"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => setIsEditing(false)}
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={saving || !email.trim()}
                className="btn btn-primary btn-xs"
              >
                {saving ? 'Enregistrement...' : 'Enregistrer le mot de passe'}
              </button>
            </div>
          </form>
        )}

        {showRemoteLogin && (
          <RemoteLoginModal
            platform={platform}
            onClose={() => setShowRemoteLogin(false)}
            onLoggedIn={() => fetchStatus()}
          />
        )}
      </div>
    );
  }

  return (
    <div className="border border-base-300 rounded-xl p-4 bg-base-100/50">
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-sm">{PLATFORM_LABELS[platform]}</span>
        {item?.configured ? (
          <div className="flex items-center gap-2">
            <span className="badge badge-success badge-sm gap-1 text-xs">
              <CheckCircle2 className="w-3 h-3" /> {isManualOnly ? 'Connecté' : item.email}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-xs text-base-content/60 hover:text-primary gap-1"
              onClick={() => setShowRemoteLogin(true)}
              title="Se reconnecter via un navigateur intégré"
            >
              <MonitorPlay className="w-3.5 h-3.5" /> Reconnecter
            </button>
            {!isManualOnly && (
              <button
                type="button"
                className="btn btn-ghost btn-xs text-base-content/60 hover:text-primary"
                onClick={() => setIsEditing(!isEditing)}
              >
                {isEditing ? 'Annuler' : 'Modifier'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-xs text-error"
              onClick={() => remove(platform)}
              title="Supprimer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="badge badge-ghost badge-sm gap-1 text-xs text-base-content/60">
              <XCircle className="w-3 h-3" /> {isManualOnly ? 'Pas de session' : 'Non configuré'}
            </span>
            <button
              type="button"
              className="btn btn-primary btn-xs gap-1"
              onClick={() => setShowRemoteLogin(true)}
            >
              <MonitorPlay className="w-3.5 h-3.5" /> {isManualOnly ? 'Se connecter à la main' : 'Se connecter'}
            </button>
            {!isEditing && !isManualOnly && (
              <button
                type="button"
                className="btn btn-ghost btn-xs text-base-content/60"
                onClick={() => setIsEditing(true)}
              >
                Autre méthode
              </button>
            )}
          </div>
        )}
      </div>

      {PLATFORM_NOTES[platform] && (
        <p className="text-xs text-base-content/50 mb-2">{PLATFORM_NOTES[platform]}</p>
      )}
      {item?.lastLoginError && <p className="text-xs text-error mb-2">{item.lastLoginError}</p>}

      {isEditing && !isManualOnly ? (
        <form onSubmit={handleSubmit} className="mt-3 pt-3 border-t border-base-300 space-y-3">
          {!supportsAutoLogin && (
            <p className="text-xs text-base-content/60 bg-base-200 rounded-lg p-2 leading-relaxed">
              {PLATFORM_LABELS[platform]} bloque la connexion automatique par mot de passe (protection
              anti-robot) — le bot ne peut réutiliser qu'une session déjà établie. Le bouton "Se
              connecter" ci-dessus (navigateur intégré) est le chemin normal. Si la vérification
              anti-robot bloque même cette fenêtre, connectez-vous à {PLATFORM_LABELS[platform]}{' '}
              normalement dans votre navigateur habituel, puis utilisez une extension comme{' '}
              <em>Cookie-Editor</em> pour exporter les cookies du site en JSON et collez le résultat
              ci-dessous.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="label py-0.5">
                <span className="label-text text-xs">Email / Identifiant (optionnel si session collée ci-dessous)</span>
              </label>
              <input
                type="email"
                placeholder="votre.compte@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input input-sm input-bordered w-full"
              />
            </div>
            {supportsAutoLogin && (
              <div>
                <label className="label py-0.5">
                  <span className="label-text text-xs">Mot de passe</span>
                </label>
                <input
                  type="password"
                  required={!item?.configured}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input input-sm input-bordered w-full"
                />
              </div>
            )}
          </div>

          {supportsAutoLogin ? (
            <div>
              <button
                type="button"
                className="text-xs text-base-content/50 hover:underline inline-block"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? '− Masquer options avancées' : '+ Importer un cookie de session (optionnel)'}
              </button>
              {showAdvanced && (
                <textarea
                  placeholder="Coller le JSON storageState (cookies) optionnel..."
                  value={sessionState}
                  onChange={(e) => setSessionState(e.target.value)}
                  className="textarea textarea-sm textarea-bordered w-full font-mono text-xs mt-1.5 h-16"
                />
              )}
            </div>
          ) : (
            <div>
              <label className="label py-0.5">
                <span className="label-text text-xs">JSON de session (obtenu via establish-session)</span>
              </label>
              <textarea
                placeholder="Coller le JSON storageState (cookies)..."
                value={sessionState}
                onChange={(e) => setSessionState(e.target.value)}
                className="textarea textarea-sm textarea-bordered w-full font-mono text-xs h-16"
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setIsEditing(false)}
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={saving || (!email.trim() && !sessionState.trim())}
              className="btn btn-primary btn-xs"
            >
              {saving ? 'Enregistrement...' : 'Enregistrer'}
            </button>
          </div>
        </form>
      ) : (
        !item?.configured &&
        !isManualOnly && (
          <p className="text-xs text-base-content/50 mt-1">
            Cliquez sur « Se connecter » pour vous connecter à {PLATFORM_LABELS[platform]} directement
            depuis un navigateur intégré à l'application — vos identifiants ne sont jamais envoyés à
            findurjob, seule la session qui en résulte est enregistrée.
          </p>
        )
      )}

      {showRemoteLogin && (
        <RemoteLoginModal
          platform={platform}
          onClose={() => setShowRemoteLogin(false)}
          onLoggedIn={() => fetchStatus()}
        />
      )}
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
                « Se connecter » ouvre un navigateur piloté par l'application, affiché en direct ici —
                connectez-vous exactement comme d'habitude (y compris CAPTCHA/2FA si demandé) et la
                session est enregistrée automatiquement dès la connexion détectée. Aucun mot de passe
                n'est stocké pour les besoins de cette méthode. Quand la session expire, vous recevez
                un email pour la rétablir.
              </p>
              <div className="space-y-3">
                <PlatformCredentialRow platform="linkedin" />
                <PlatformCredentialRow platform="indeed" />
                <PlatformCredentialRow platform="france_travail" />
                <PlatformCredentialRow platform="hellowork" />
                <PlatformCredentialRow platform="welcome_to_the_jungle" />
                <PlatformCredentialRow platform="apec" />
                <PlatformCredentialRow platform="gmail" />
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
