'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, FileText, Rocket, Briefcase, Sparkles, Settings } from 'lucide-react';
import clsx from 'clsx';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/mon-cv', label: 'Mon CV', icon: FileText },
  { href: '/campagne', label: 'Campagne', icon: Rocket },
  { href: '/candidatures', label: 'Candidatures', icon: Briefcase },
  { href: '/parametres', label: 'Paramètres', icon: Settings },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen flex bg-base-100">
      <aside className="w-64 shrink-0 border-r border-base-300 flex flex-col">
        <div className="px-6 py-6 flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary-content" />
          </div>
          <span className="text-lg font-semibold tracking-tight">FindUrJob</span>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary/15 text-primary'
                    : 'text-base-content/60 hover:text-base-content hover:bg-base-200',
                )}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="px-6 py-4 text-xs text-base-content/40">
          Copilote de candidatures IA
        </div>
      </aside>

      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
