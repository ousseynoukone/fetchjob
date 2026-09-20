'use client';

import React, { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApplicationsStore, Application } from '@/lib/applications-store';
import { useCampaignStore } from '@/lib/campaign-store';
import AppShell from '@/components/layout/app-shell';
import AddOfferModal from './add-offer-modal';
import {
  MapPin,
  Building2,
  Plus,
  Trash2,
  ChevronDown,
  CalendarClock,
  CalendarCheck,
  RotateCcw,
  AlertCircle,
  Search,
  X,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Sparkles,
  LayoutGrid,
  LayoutList,
  ExternalLink,
  Briefcase,
  ArrowRight,
  Send,
  Eye,
  Check,
} from 'lucide-react';

// Main category definitions requested by user:
// Réussi (applied, interview, offer)
// Échoué / À vérifier (needs_review)
// À postuler (to_apply)
// Écarté (rejected, ignored)
export type CategoryId = 'all' | 'success' | 'failed' | 'to_apply' | 'discarded';

interface CategoryConfig {
  id: CategoryId;
  label: string;
  subLabel: string;
  statuses?: string[];
  icon: React.ComponentType<{ className?: string }>;
  accentColor: string;
  badgeClass: string;
  cardBorderClass: string;
  cardBgClass: string;
}

const CATEGORIES: CategoryConfig[] = [
  {
    id: 'all',
    label: 'Toutes',
    subLabel: 'Toutes les candidatures',
    icon: Briefcase,
    accentColor: 'text-base-content',
    badgeClass: 'badge-ghost',
    cardBorderClass: 'hover:border-primary/40',
    cardBgClass: 'bg-base-200/50',
  },
  {
    id: 'success',
    label: 'Réussies',
    subLabel: 'Envoyées & Entretiens',
    statuses: ['applied', 'interview', 'offer'],
    icon: CheckCircle2,
    accentColor: 'text-success',
    badgeClass: 'badge-success bg-success/15 text-success border-success/30',
    cardBorderClass: 'border-success/30 hover:border-success',
    cardBgClass: 'bg-success/5',
  },
  {
    id: 'failed',
    label: 'Échouées',
    subLabel: 'À vérifier & champs bloquants',
    statuses: ['needs_review'],
    icon: AlertTriangle,
    accentColor: 'text-warning',
    badgeClass: 'badge-warning bg-warning/15 text-warning border-warning/30',
    cardBorderClass: 'border-warning/40 hover:border-warning',
    cardBgClass: 'bg-warning/5',
  },
  {
    id: 'to_apply',
    label: 'À postuler',
    subLabel: 'En attente dans la file',
    statuses: ['to_apply'],
    icon: Clock,
    accentColor: 'text-info',
    badgeClass: 'badge-info bg-info/15 text-info border-info/30',
    cardBorderClass: 'border-info/30 hover:border-info',
    cardBgClass: 'bg-info/5',
  },
  {
    id: 'discarded',
    label: 'Écartées',
    subLabel: 'Refusées ou ignorées',
    statuses: ['rejected', 'ignored'],
    icon: XCircle,
    accentColor: 'text-base-content/60',
    badgeClass: 'badge-ghost text-base-content/60',
    cardBorderClass: 'border-base-300 hover:border-base-content/40',
    cardBgClass: 'bg-base-200/30',
  },
];

const PLATFORM_LABELS: Record<string, { label: string; badge: string }> = {
  linkedin: { label: 'LinkedIn', badge: 'bg-blue-600/15 text-blue-400 border-blue-500/30' },
  hellowork: { label: 'HelloWork', badge: 'bg-purple-600/15 text-purple-400 border-purple-500/30' },
  france_travail: { label: 'France Travail', badge: 'bg-sky-600/15 text-sky-400 border-sky-500/30' },
  welcome_to_the_jungle: { label: 'Welcome to the Jungle', badge: 'bg-amber-600/15 text-amber-400 border-amber-500/30' },
  apec: { label: 'APEC', badge: 'bg-emerald-600/15 text-emerald-400 border-emerald-500/30' },
  indeed: { label: 'Indeed', badge: 'bg-indigo-600/15 text-indigo-400 border-indigo-500/30' },
  adzuna: { label: 'Adzuna', badge: 'bg-teal-600/15 text-teal-400 border-teal-500/30' },
  the_muse: { label: 'The Muse', badge: 'bg-pink-600/15 text-pink-400 border-pink-500/30' },
};

const STATUS_DETAILS: Record<string, { label: string; badgeClass: string; icon: React.ComponentType<{ className?: string }> }> = {
  applied: { label: 'Envoyée', badgeClass: 'badge-success bg-success/15 text-success border-success/30', icon: CheckCircle2 },
  interview: { label: 'Entretien', badgeClass: 'badge-secondary bg-secondary/15 text-secondary border-secondary/30', icon: Sparkles },
  offer: { label: 'Offre reçue', badgeClass: 'badge-success font-semibold', icon: Sparkles },
  needs_review: { label: 'À vérifier', badgeClass: 'badge-warning bg-warning/15 text-warning border-warning/30', icon: AlertTriangle },
  to_apply: { label: 'Prête à postuler', badgeClass: 'badge-info bg-info/15 text-info border-info/30', icon: Clock },
  rejected: { label: 'Refusée', badgeClass: 'badge-error bg-error/15 text-error border-error/30', icon: XCircle },
  ignored: { label: 'Ignorée', badgeClass: 'badge-ghost text-base-content/50', icon: XCircle },
};

function formatDate(iso?: string) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function scoreColor(score: number) {
  if (score >= 80) return 'text-success border-success/30 bg-success/10';
  if (score >= 60) return 'text-warning border-warning/30 bg-warning/10';
  return 'text-base-content/40 border-base-300 bg-base-200';
}

export default function ApplicationsList() {
  const { applications, loading, fetchList, removeAll, retryOne } = useApplicationsStore();
  const { retryFailed, running: campaignRunning } = useCampaignStore();
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL tab mapping
  const urlTab = searchParams.get('tab') || 'all';

  // Map legacy URL tabs (applied, needs_review, to_apply, rejected, etc.) to CategoryId
  const initialCategory: CategoryId = useMemo(() => {
    if (urlTab === 'applied' || urlTab === 'interview' || urlTab === 'offer' || urlTab === 'success') return 'success';
    if (urlTab === 'needs_review' || urlTab === 'failed') return 'failed';
    if (urlTab === 'to_apply' || urlTab === 'to_apply_history') return 'to_apply';
    if (urlTab === 'rejected' || urlTab === 'ignored' || urlTab === 'discarded') return 'discarded';
    return 'all';
  }, [urlTab]);

  const [activeCategory, setActiveCategory] = useState<CategoryId>(initialCategory);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<string>('');
  const [sortBy, setSortBy] = useState<'recent' | 'score' | 'company' | 'postedAt'>('recent');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showAddModal, setShowAddModal] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [clearTarget, setClearTarget] = useState<'category' | 'all' | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Load all applications on mount
  useEffect(() => {
    fetchList();
  }, [fetchList]);

  // Synchronize category state when URL changes
  useEffect(() => {
    setActiveCategory(initialCategory);
  }, [initialCategory]);

  const handleCategoryChange = (id: CategoryId) => {
    setActiveCategory(id);
    if (id === 'all') {
      router.replace('/candidatures');
    } else if (id === 'success') {
      router.replace('/candidatures?tab=applied');
    } else if (id === 'failed') {
      router.replace('/candidatures?tab=needs_review');
    } else if (id === 'to_apply') {
      router.replace('/candidatures?tab=to_apply');
    } else if (id === 'discarded') {
      router.replace('/candidatures?tab=discarded');
    }
  };

  const handleRetryFailed = async () => {
    await retryFailed();
    router.push('/campagne');
  };

  const handleRetrySingle = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      setRetryingId(id);
      await retryOne(id);
      router.push('/campagne');
    } finally {
      setRetryingId(null);
    }
  };

  // Category counts (computed from the full application list)
  const counts = useMemo(() => {
    const res: Record<CategoryId, number> = {
      all: applications.length,
      success: 0,
      failed: 0,
      to_apply: 0,
      discarded: 0,
    };
    for (const app of applications) {
      if (['applied', 'interview', 'offer'].includes(app.status)) {
        res.success++;
      } else if (app.status === 'needs_review') {
        res.failed++;
      } else if (app.status === 'to_apply') {
        res.to_apply++;
      } else if (['rejected', 'ignored'].includes(app.status)) {
        res.discarded++;
      }
    }
    return res;
  }, [applications]);

  // Available platforms extracted from applications
  const platformOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const app of applications) {
      const src = app.jobOffer?.source || 'autre';
      map.set(src, (map.get(src) || 0) + 1);
    }
    return Array.from(map.entries()).map(([source, count]) => ({
      id: source,
      label: PLATFORM_LABELS[source]?.label || source.replace(/_/g, ' ').toUpperCase(),
      count,
    }));
  }, [applications]);

  // Filtered and sorted applications
  const filteredApplications = useMemo(() => {
    let list = applications;

    // 1. Filter by category
    const activeCfg = CATEGORIES.find((c) => c.id === activeCategory);
    if (activeCfg?.statuses && activeCfg.statuses.length > 0) {
      list = list.filter((app) => activeCfg.statuses!.includes(app.status));
    }

    // 2. Filter by platform
    if (selectedPlatform) {
      list = list.filter((app) => (app.jobOffer?.source || '').toLowerCase() === selectedPlatform.toLowerCase());
    }

    // 3. Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((app) => {
        const titleMatch = (app.jobTitle || '').toLowerCase().includes(q);
        const companyMatch = (app.company || '').toLowerCase().includes(q);
        const locationMatch = (app.location || '').toLowerCase().includes(q);
        const sourceMatch = (app.jobOffer?.source || '').toLowerCase().includes(q);
        const noteMatch = (app.autoApplyNote || '').toLowerCase().includes(q);
        const skillsMatch = (app.matchedSkills || []).some((s) => s.toLowerCase().includes(q));
        const descMatch = (app.jobOffer?.description || '').toLowerCase().includes(q);
        return titleMatch || companyMatch || locationMatch || sourceMatch || noteMatch || skillsMatch || descMatch;
      });
    }

    // 4. Sort
    return [...list].sort((a, b) => {
      if (sortBy === 'score') {
        return (b.matchScore || 0) - (a.matchScore || 0);
      }
      if (sortBy === 'company') {
        return (a.company || '').localeCompare(b.company || '');
      }
      if (sortBy === 'postedAt') {
        const dateA = a.jobOffer?.postedAt ? new Date(a.jobOffer.postedAt).getTime() : 0;
        const dateB = b.jobOffer?.postedAt ? new Date(b.jobOffer.postedAt).getTime() : 0;
        return dateB - dateA;
      }
      // 'recent' default
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return dateB - dateA;
    });
  }, [applications, activeCategory, selectedPlatform, searchQuery, sortBy]);

  const activeCategoryConfig = CATEGORIES.find((c) => c.id === activeCategory) || CATEGORIES[0];

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header with Title & Top Actions */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold tracking-tight">Candidatures</h1>
              <span className="badge badge-neutral text-xs font-semibold px-2.5 py-1">
                {applications.length} au total
              </span>
            </div>
            <p className="text-base-content/60 text-sm mt-1">
              Gérez, recherchez et relancez vos candidatures automatisées ou manuelles
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {counts.failed > 0 && (
              <button
                className="btn btn-warning btn-sm gap-1.5 shadow-sm"
                disabled={campaignRunning}
                onClick={handleRetryFailed}
                title="Relancer toutes les candidatures en échec"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Réessayer les échecs ({counts.failed})</span>
              </button>
            )}

            {/* Clean Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setDropdownOpen((v) => !v)}
                className="btn btn-outline btn-sm gap-1.5"
                title="Nettoyer des candidatures"
              >
                <Trash2 className="w-4 h-4" />
                <span>Nettoyer</span>
                <ChevronDown className="w-3 h-3 opacity-60" />
              </button>

              {dropdownOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setDropdownOpen(false)} />
                  <ul className="absolute right-0 top-full mt-2 z-30 p-1.5 shadow-2xl bg-base-200 border border-base-300 rounded-xl w-64 menu">
                    {activeCategory !== 'all' && (
                      <li>
                        <button
                          type="button"
                          disabled={filteredApplications.length === 0}
                          onClick={() => {
                            setDropdownOpen(false);
                            setClearTarget('category');
                          }}
                        >
                          <Trash2 className="w-4 h-4 text-warning" />
                          <span>Supprimer "{activeCategoryConfig.label}" ({filteredApplications.length})</span>
                        </button>
                      </li>
                    )}
                    <li>
                      <button
                        type="button"
                        className="text-error font-medium"
                        onClick={() => {
                          setDropdownOpen(false);
                          setClearTarget('all');
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                        <span>Tout supprimer ({applications.length})</span>
                      </button>
                    </li>
                  </ul>
                </>
              )}
            </div>

            <button className="btn btn-primary btn-sm gap-1.5 shadow-sm" onClick={() => setShowAddModal(true)}>
              <Plus className="w-4 h-4" />
              <span>Ajouter une offre</span>
            </button>
          </div>
        </div>

        {/* Categories / Agencement de l'espace (Réussies, Échouées, À postuler, Écartées) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isSelected = activeCategory === cat.id;
            const count = counts[cat.id];

            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => handleCategoryChange(cat.id)}
                className={`flex flex-col items-start p-3.5 rounded-xl border text-left transition-all relative overflow-hidden ${
                  isSelected
                    ? 'border-primary bg-base-200 ring-2 ring-primary/30 shadow-md'
                    : 'border-base-300 bg-base-200/40 hover:bg-base-200/80 hover:border-base-content/20'
                }`}
              >
                <div className="flex items-center justify-between w-full mb-1.5">
                  <div className={`p-1.5 rounded-lg ${cat.cardBgClass} ${cat.accentColor}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className={`text-xl font-bold ${cat.accentColor}`}>{count}</span>
                </div>
                <div className="font-semibold text-sm leading-tight text-base-content">{cat.label}</div>
                <div className="text-[11px] text-base-content/50 truncate w-full mt-0.5">{cat.subLabel}</div>
                {isSelected && (
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-primary rounded-b-xl" />
                )}
              </button>
            );
          })}
        </div>

        {/* Unified Search & Filters Toolbar */}
        <div className="bg-base-200/80 border border-base-300 rounded-2xl p-3.5 mb-6 shadow-sm">
          <div className="flex flex-col md:flex-row gap-2.5 items-stretch md:items-center justify-between">
            {/* Realtime Search Input */}
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-base-content/40 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Rechercher par poste, entreprise, ville, compétence, motif d'erreur..."
                className="input input-sm input-bordered w-full pl-9 pr-8 bg-base-100/70 border-base-300 text-sm focus:border-primary focus:bg-base-100 rounded-xl"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-base-content/40 hover:text-base-content"
                  title="Effacer la recherche"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Platform & Sort & View Mode */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Platform Selector */}
              <select
                value={selectedPlatform}
                onChange={(e) => setSelectedPlatform(e.target.value)}
                className="select select-bordered select-sm bg-base-100/80 border-base-300 text-xs font-medium rounded-xl"
              >
                <option value="">Toutes les plateformes</option>
                {platformOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({p.count})
                  </option>
                ))}
              </select>

              {/* Sort Selector */}
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="select select-bordered select-sm bg-base-100/80 border-base-300 text-xs font-medium rounded-xl"
              >
                <option value="recent">Plus récentes</option>
                <option value="score">Score de match (↓)</option>
                <option value="company">Entreprise (A-Z)</option>
                <option value="postedAt">Date de publication</option>
              </select>

              {/* View Toggle */}
              <div className="join border border-base-300 rounded-xl p-0.5 bg-base-100/80 shrink-0">
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`join-item btn btn-xs ${viewMode === 'grid' ? 'btn-primary' : 'btn-ghost text-base-content/50'}`}
                  title="Vue cartes"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className={`join-item btn btn-xs ${viewMode === 'list' ? 'btn-primary' : 'btn-ghost text-base-content/50'}`}
                  title="Vue liste compacte"
                >
                  <LayoutList className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Active Filter summary if filtered */}
          {(searchQuery || selectedPlatform) && (
            <div className="flex items-center justify-between text-xs text-base-content/60 mt-2.5 pt-2.5 border-t border-base-300/50">
              <div className="flex items-center gap-2">
                <span>
                  <strong>{filteredApplications.length}</strong> candidature(s) trouvée(s)
                  {searchQuery && <> pour "<span className="text-primary font-medium">{searchQuery}</span>"</>}
                  {selectedPlatform && (
                    <> sur <span className="badge badge-xs badge-neutral capitalize">{selectedPlatform.replace(/_/g, ' ')}</span></>
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSelectedPlatform('');
                }}
                className="text-primary hover:underline"
              >
                Réinitialiser les filtres
              </button>
            </div>
          )}
        </div>

        {/* Main Content: Loading, Empty, or Results */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <span className="loading loading-spinner loading-lg text-primary" />
            <span className="text-sm text-base-content/50 mt-3">Chargement des candidatures...</span>
          </div>
        ) : filteredApplications.length === 0 ? (
          <div className="bg-base-200/50 border border-base-300 rounded-2xl p-12 text-center">
            <div className="w-12 h-12 rounded-2xl bg-base-300/50 flex items-center justify-center mx-auto mb-3 text-base-content/40">
              <Search className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-semibold text-base-content">
              {searchQuery || selectedPlatform
                ? 'Aucune candidature ne correspond à votre recherche'
                : `Aucune candidature dans l'espace "${activeCategoryConfig.label}"`}
            </h3>
            <p className="text-sm text-base-content/50 max-w-md mx-auto mt-1">
              {searchQuery || selectedPlatform
                ? 'Essayez de modifier vos mots-clés ou de retirer les filtres de plateforme.'
                : 'Les candidatures préparées apparaîtront ici au fil de vos campagnes ou ajouts manuels.'}
            </p>
            <div className="flex justify-center gap-2 mt-5">
              {searchQuery || selectedPlatform ? (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedPlatform('');
                  }}
                >
                  Effacer la recherche
                </button>
              ) : (
                <>
                  <Link href="/campagne" className="btn btn-primary btn-sm">
                    Configurer une campagne
                  </Link>
                  <button className="btn btn-outline btn-sm" onClick={() => setShowAddModal(true)}>
                    Ajouter une offre
                  </button>
                </>
              )}
            </div>
          </div>
        ) : viewMode === 'grid' ? (
          /* Grid View */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredApplications.map((app) => {
              const statusCfg = STATUS_DETAILS[app.status] || {
                label: app.status.replace(/_/g, ' '),
                badgeClass: 'badge-ghost',
                icon: AlertCircle,
              };
              const StatusIcon = statusCfg.icon;
              const platformCfg = PLATFORM_LABELS[app.jobOffer?.source || ''] || {
                label: (app.jobOffer?.source || 'externe').replace(/_/g, ' '),
                badge: 'bg-base-300 text-base-content/60 border-base-300',
              };

              return (
                <div
                  key={app.id}
                  className={`bg-base-200/70 border rounded-2xl p-5 transition-all hover:border-primary/50 hover:bg-base-200/90 flex flex-col justify-between group ${
                    app.status === 'needs_review'
                      ? 'border-warning/30 shadow-sm'
                      : app.status === 'applied'
                      ? 'border-success/20'
                      : 'border-base-300'
                  }`}
                >
                  <div>
                    {/* Top Row: Score + Platform + Status */}
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2">
                        {/* Match Score */}
                        <span
                          className={`badge border text-xs font-bold px-2 py-1 ${scoreColor(app.matchScore)}`}
                          title={`Score de pertinence : ${app.matchScore}/100`}
                        >
                          {app.matchScore}% match
                        </span>

                        {/* Platform Badge */}
                        <span
                          className={`badge badge-sm border text-[11px] font-medium px-2 ${platformCfg.badge}`}
                        >
                          {platformCfg.label}
                        </span>
                      </div>

                      {/* Status Badge */}
                      <span className={`badge badge-sm border gap-1 px-2.5 py-1 ${statusCfg.badgeClass}`}>
                        <StatusIcon className="w-3 h-3" />
                        <span>{statusCfg.label}</span>
                      </span>
                    </div>

                    {/* Job Title & Company */}
                    <Link href={`/candidatures/${app.id}`} className="block">
                      <h3 className="font-bold text-base text-base-content group-hover:text-primary transition-colors line-clamp-2 leading-snug">
                        {app.jobTitle}
                      </h3>
                    </Link>

                    <div className="flex items-center gap-4 text-xs text-base-content/60 mt-1.5 flex-wrap">
                      <span className="flex items-center gap-1 font-medium text-base-content/80">
                        <Building2 className="w-3.5 h-3.5 shrink-0" />
                        {app.company}
                      </span>
                      {app.location && (
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5 shrink-0" />
                          {app.location}
                        </span>
                      )}
                      {app.jobOffer?.contractType && (
                        <span className="badge badge-ghost badge-xs">{app.jobOffer.contractType}</span>
                      )}
                    </div>

                    {/* Matched skills preview */}
                    {app.matchedSkills && app.matchedSkills.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
                        {app.matchedSkills.slice(0, 4).map((skill, idx) => (
                          <span
                            key={idx}
                            className="bg-base-300/70 border border-base-content/5 text-[11px] text-base-content/70 px-2 py-0.5 rounded-md"
                          >
                            {skill}
                          </span>
                        ))}
                        {app.matchedSkills.length > 4 && (
                          <span className="text-[10px] text-base-content/40">
                            +{app.matchedSkills.length - 4}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Needs Review Alert Box + Direct Retry */}
                    {app.status === 'needs_review' && (
                      <div className="mt-3 text-xs bg-warning/10 border border-warning/25 rounded-xl p-2.5 text-warning flex items-start justify-between gap-2">
                        <div className="flex items-start gap-1.5 min-w-0 flex-1">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span className="line-clamp-2 text-[11px] leading-relaxed">
                            {app.autoApplyNote || 'Formulaire incomplet ou question personnalisée requise.'}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={campaignRunning || retryingId === app.id}
                          onClick={(e) => handleRetrySingle(e, app.id)}
                          className="btn btn-warning btn-xs shrink-0 gap-1 shadow-sm"
                          title="Relancer cette candidature immédiatement"
                        >
                          <RotateCcw className={`w-3 h-3 ${retryingId === app.id ? 'animate-spin' : ''}`} />
                          <span>Réessayer</span>
                        </button>
                      </div>
                    )}

                    {/* Applied Date Banner if applied */}
                    {app.status === 'applied' && app.appliedAt && (
                      <div className="mt-2.5 text-[11px] text-success/90 flex items-center gap-1.5 bg-success/5 border border-success/15 rounded-lg px-2 py-1">
                        <Check className="w-3 h-3 text-success shrink-0" />
                        <span>Candidature transmise avec succès le {formatDate(app.appliedAt)}</span>
                      </div>
                    )}
                  </div>

                  {/* Bottom Footer Actions */}
                  <div className="flex items-center justify-between pt-3 mt-3 border-t border-base-300/50 text-xs text-base-content/40">
                    <div className="flex items-center gap-3">
                      {formatDate(app.jobOffer?.postedAt) && (
                        <span className="flex items-center gap-1" title="Date de publication">
                          <CalendarClock className="w-3 h-3" /> {formatDate(app.jobOffer?.postedAt)}
                        </span>
                      )}
                      {formatDate(app.createdAt) && !app.jobOffer?.postedAt && (
                        <span className="flex items-center gap-1" title="Date d'ajout">
                          <CalendarCheck className="w-3 h-3" /> {formatDate(app.createdAt)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {app.sourceUrl && (
                        <a
                          href={app.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-ghost btn-xs text-base-content/60 hover:text-base-content gap-1"
                          title="Ouvrir l'offre originale dans un nouvel onglet"
                        >
                          <span>Offre</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      <Link
                        href={`/candidatures/${app.id}`}
                        className="btn btn-primary btn-xs gap-1"
                        title="Consulter le CV adapté et la lettre de motivation"
                      >
                        <span>Dossier</span>
                        <ArrowRight className="w-3 h-3" />
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* List / Table View */
          <div className="bg-base-200/80 border border-base-300 rounded-2xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="table table-sm w-full">
                <thead>
                  <tr className="bg-base-300/40 text-base-content/70 text-xs border-b border-base-300">
                    <th className="py-3 px-4">Score</th>
                    <th>Poste & Entreprise</th>
                    <th>Localisation</th>
                    <th>Plateforme</th>
                    <th>Statut</th>
                    <th>Date</th>
                    <th className="text-right px-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base-300/40 text-xs">
                  {filteredApplications.map((app) => {
                    const statusCfg = STATUS_DETAILS[app.status] || {
                      label: app.status,
                      badgeClass: 'badge-ghost',
                      icon: AlertCircle,
                    };
                    const StatusIcon = statusCfg.icon;
                    const platformCfg = PLATFORM_LABELS[app.jobOffer?.source || ''] || {
                      label: app.jobOffer?.source || 'externe',
                      badge: 'bg-base-300 text-base-content/60',
                    };

                    return (
                      <tr key={app.id} className="hover:bg-base-300/20 transition-colors">
                        <td className="px-4 py-3 font-bold">
                          <span className={`badge badge-sm border ${scoreColor(app.matchScore)}`}>
                            {app.matchScore}%
                          </span>
                        </td>
                        <td className="font-medium max-w-xs">
                          <Link
                            href={`/candidatures/${app.id}`}
                            className="text-base-content hover:text-primary transition-colors font-semibold block truncate"
                          >
                            {app.jobTitle}
                          </Link>
                          <div className="text-[11px] text-base-content/60 flex items-center gap-1 mt-0.5">
                            <Building2 className="w-3 h-3" />
                            <span>{app.company}</span>
                          </div>
                        </td>
                        <td className="text-base-content/60">
                          {app.location ? (
                            <span className="flex items-center gap-1">
                              <MapPin className="w-3 h-3 shrink-0" />
                              <span className="truncate max-w-[120px]">{app.location}</span>
                            </span>
                          ) : (
                            <span className="text-base-content/30">—</span>
                          )}
                        </td>
                        <td>
                          <span className={`badge badge-xs border ${platformCfg.badge}`}>
                            {platformCfg.label}
                          </span>
                        </td>
                        <td>
                          <div className="flex flex-col gap-1 items-start">
                            <span className={`badge badge-xs border gap-1 py-0.5 ${statusCfg.badgeClass}`}>
                              <StatusIcon className="w-2.5 h-2.5" />
                              <span>{statusCfg.label}</span>
                            </span>
                            {app.status === 'needs_review' && app.autoApplyNote && (
                              <span
                                className="text-[10px] text-warning truncate max-w-[160px]"
                                title={app.autoApplyNote}
                              >
                                {app.autoApplyNote}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="text-base-content/50 whitespace-nowrap">
                          {formatDate(app.jobOffer?.postedAt || app.createdAt)}
                        </td>
                        <td className="text-right px-4 whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            {app.status === 'needs_review' && (
                              <button
                                type="button"
                                disabled={campaignRunning || retryingId === app.id}
                                onClick={(e) => handleRetrySingle(e, app.id)}
                                className="btn btn-warning btn-xs"
                                title="Réessayer"
                              >
                                <RotateCcw className={`w-3 h-3 ${retryingId === app.id ? 'animate-spin' : ''}`} />
                              </button>
                            )}
                            {app.sourceUrl && (
                              <a
                                href={app.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn btn-ghost btn-xs text-base-content/50 hover:text-base-content"
                                title="Voir l'offre originale"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                            <Link
                              href={`/candidatures/${app.id}`}
                              className="btn btn-primary btn-xs"
                              title="Détail de la candidature"
                            >
                              <Eye className="w-3 h-3" />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Modal: Add Manual Offer */}
        {showAddModal && <AddOfferModal onClose={() => setShowAddModal(false)} />}

        {/* Modal: Confirmation deletion */}
        {clearTarget && (
          <div
            className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4"
            onClick={() => setClearTarget(null)}
          >
            <div
              className="bg-base-200 border border-base-300 rounded-2xl p-6 w-full max-w-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 text-error mb-3">
                <div className="w-10 h-10 rounded-full bg-error/15 flex items-center justify-center">
                  <Trash2 className="w-5 h-5" />
                </div>
                <h3 className="text-lg font-bold text-base-content">
                  {clearTarget === 'category'
                    ? `Supprimer les candidatures "${activeCategoryConfig.label}"`
                    : 'Supprimer TOUTES les candidatures'}
                </h3>
              </div>
              <p className="text-sm text-base-content/70 mb-6">
                {clearTarget === 'category'
                  ? `Voulez-vous vraiment supprimer les ${filteredApplications.length} candidature(s) de l'espace "${activeCategoryConfig.label}" ? Cette action est irréversible.`
                  : 'Voulez-vous vraiment supprimer TOUTES les candidatures de tous les espaces ? Cette action est irréversible.'}
              </p>
              <div className="flex justify-end gap-2.5">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClearTarget(null)}>
                  Annuler
                </button>
                <button
                  type="button"
                  className="btn btn-error btn-sm gap-1.5"
                  onClick={async () => {
                    const target = clearTarget;
                    setClearTarget(null);
                    if (target === 'category' && activeCategoryConfig.statuses) {
                      for (const st of activeCategoryConfig.statuses) {
                        await removeAll(st);
                      }
                    } else {
                      await removeAll();
                    }
                    await fetchList();
                  }}
                >
                  <Trash2 className="w-4 h-4" />
                  Confirmer la suppression
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
