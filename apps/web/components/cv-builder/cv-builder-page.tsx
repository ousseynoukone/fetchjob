'use client';

import React, { useEffect, useState } from 'react';
import { useCVStore } from '@/lib/cv-store';
import apiClient from '@/lib/api-client';
import AppShell from '@/components/layout/app-shell';
import CVPreview from './cv-preview';
import IdentiteSection from './sections/identite-section';
import CompetencesSection from './sections/competences-section';
import ExperiencesSection from './sections/experiences-section';
import FormationsSection from './sections/formations-section';
import ProjetsSection from './sections/projets-section';
import CertificationsSection from './sections/certifications-section';
import LanguesSection from './sections/langues-section';
import { Download, User, Wrench, Briefcase, GraduationCap, FolderKanban, Award, Languages } from 'lucide-react';

const TABS = [
  { id: 'identite', label: 'Identité', icon: User },
  { id: 'competences', label: 'Compétences', icon: Wrench },
  { id: 'experiences', label: 'Expériences', icon: Briefcase },
  { id: 'formations', label: 'Formations', icon: GraduationCap },
  { id: 'projets', label: 'Projets', icon: FolderKanban },
  { id: 'certifications', label: 'Certifications', icon: Award },
  { id: 'langues', label: 'Langues', icon: Languages },
];

export default function CVBuilderPage() {
  const { cv, loading, fetchCV } = useCVStore();
  const [activeTab, setActiveTab] = useState('identite');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    fetchCV();
  }, [fetchCV]);

  const handleDownloadPdf = async () => {
    setDownloading(true);
    try {
      const response = await apiClient.get('/api/cv/pdf', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${cv?.fullName || 'cv'}.pdf`;
      link.click();
      window.URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const renderSection = () => {
    switch (activeTab) {
      case 'identite':
        return <IdentiteSection />;
      case 'competences':
        return <CompetencesSection />;
      case 'experiences':
        return <ExperiencesSection />;
      case 'formations':
        return <FormationsSection />;
      case 'projets':
        return <ProjetsSection />;
      case 'certifications':
        return <CertificationsSection />;
      case 'langues':
        return <LanguesSection />;
      default:
        return null;
    }
  };

  return (
    <AppShell>
      <div className="max-w-[1400px] mx-auto px-8 py-10">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Mon CV</h1>
            <p className="text-base-content/50 mt-1">Construisez votre CV, l'aperçu se met à jour à chaque enregistrement</p>
          </div>
          <button
            className="btn btn-primary gap-2"
            disabled={downloading || loading}
            onClick={handleDownloadPdf}
          >
            {downloading ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {downloading ? 'Génération...' : 'Télécharger le PDF'}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[200px_460px_1fr] gap-6 items-start">
          {/* Section nav */}
          <div className="bg-base-200 border border-base-300 rounded-2xl p-2 flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-primary/15 text-primary'
                      : 'text-base-content/60 hover:text-base-content hover:bg-base-300'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Form */}
          <div className="bg-base-200 border border-base-300 rounded-2xl p-6 min-h-[400px]">
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <span className="loading loading-spinner loading-lg" />
              </div>
            ) : (
              renderSection()
            )}
          </div>

          {/* Preview */}
          <div className="sticky top-10 max-w-[820px]">
            <div className="rounded-2xl overflow-hidden shadow-2xl shadow-black/40 ring-1 ring-base-300">
              <CVPreview />
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
