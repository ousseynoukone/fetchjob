'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FileText, Rocket, Briefcase, Settings, ArrowUpRight, ClipboardList, Send, Target, CalendarClock } from 'lucide-react';
import AppShell from '@/components/layout/app-shell';
import apiClient from '@/lib/api-client';

const FEATURES = [
  {
    title: 'Votre CV',
    description: 'Créez et gérez votre CV professionnel avec le générateur intégré.',
    icon: FileText,
    href: '/mon-cv',
    cta: 'Éditer le CV',
    enabled: true,
  },
  {
    title: 'Campagne',
    description: 'Lancez une recherche automatisée : scraping, matching et préparation IA.',
    icon: Rocket,
    href: '/campagne',
    cta: 'Configurer',
    enabled: true,
  },
  {
    title: 'Candidatures',
    description: 'Suivez chaque candidature préparée par l’IA et son statut.',
    icon: Briefcase,
    href: '/candidatures',
    cta: 'Voir la liste',
    enabled: true,
  },
  {
    title: 'Préférences',
    description: 'Réglages de notification et de recherche par défaut.',
    icon: Settings,
    href: '#',
    cta: 'Bientôt disponible',
    enabled: false,
  },
];

export default function Dashboard() {
  const [stats, setStats] = useState([
    { label: 'Candidatures prêtes', value: '—', icon: ClipboardList },
    { label: 'Candidatures envoyées', value: '—', icon: Send },
    { label: 'Score de matching moyen', value: '—', icon: Target },
    { label: 'Offres scannées', value: '—', icon: CalendarClock },
  ]);

  useEffect(() => {
    Promise.all([
      apiClient.get('/api/campagne/stats'),
      apiClient.get('/api/candidatures'),
    ])
      .then(([campaignRes, applicationsRes]) => {
        const campaign = campaignRes.data;
        const applications: { status: string; matchScore: number }[] = applicationsRes.data;
        const toApply = applications.filter((a) => a.status === 'to_apply').length;
        const avgScore = applications.length
          ? Math.round(applications.reduce((sum, a) => sum + a.matchScore, 0) / applications.length)
          : null;

        setStats([
          { label: 'Candidatures prêtes', value: String(toApply), icon: ClipboardList },
          { label: 'Candidatures envoyées', value: String(campaign.totalApplicationsSent), icon: Send },
          { label: 'Score de matching moyen', value: avgScore !== null ? String(avgScore) : '—', icon: Target },
          { label: 'Offres scannées', value: String(campaign.totalOffersScanned), icon: CalendarClock },
        ]);
      })
      .catch(() => {
        // keep placeholders if the API is unreachable
      });
  }, []);

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto px-8 py-10">
        <div className="mb-10">
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-base-content/50 mt-1">Vue d'ensemble de votre recherche d'emploi</p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div
                key={stat.label}
                className="bg-base-200 border border-base-300 rounded-2xl p-5"
              >
                <Icon className="w-5 h-5 text-primary mb-3" />
                <div className="text-2xl font-semibold">{stat.value}</div>
                <div className="text-sm text-base-content/50 mt-1">{stat.label}</div>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            const content = (
              <div
                className={clsxCard(feature.enabled)}
              >
                <div className="flex items-start justify-between">
                  <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center mb-4">
                    <Icon className="w-5 h-5 text-primary" />
                  </div>
                  {feature.enabled && <ArrowUpRight className="w-4 h-4 text-base-content/30" />}
                </div>
                <h3 className="text-lg font-semibold mb-1.5">{feature.title}</h3>
                <p className="text-sm text-base-content/50 leading-relaxed mb-4">
                  {feature.description}
                </p>
                <span
                  className={
                    feature.enabled
                      ? 'text-sm font-medium text-primary'
                      : 'text-sm font-medium text-base-content/30'
                  }
                >
                  {feature.cta}
                </span>
              </div>
            );

            return feature.enabled ? (
              <Link key={feature.title} href={feature.href}>
                {content}
              </Link>
            ) : (
              <div key={feature.title} className="cursor-not-allowed">
                {content}
              </div>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}

function clsxCard(enabled: boolean) {
  return [
    'bg-base-200 border border-base-300 rounded-2xl p-6 h-full transition-colors',
    enabled ? 'hover:border-primary/40 cursor-pointer' : 'opacity-50',
  ].join(' ');
}
