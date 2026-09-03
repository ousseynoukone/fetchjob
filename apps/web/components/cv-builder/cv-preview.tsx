'use client';

import React from 'react';
import { useCVStore } from '@/lib/cv-store';
import CVPreviewAts from './cv-preview-ats';
import { Mail, Phone, MapPin, Link as LinkIcon } from 'lucide-react';

const DEFAULT_ACCENT = '#2d5bff';
const SIDEBAR_BG = '#111827';

export default function CVPreview() {
  const { cv } = useCVStore();

  if (!cv) return null;

  if (cv.options?.template === 'ats') {
    return <CVPreviewAts />;
  }

  const fontSize = cv.options?.fontSize || 11;
  const compact = cv.options?.compact || false;
  const gap = compact ? 'space-y-3' : 'space-y-4';
  const ACCENT = cv.options?.accent || DEFAULT_ACCENT;

  return (
    <div
      style={{ fontSize: `${fontSize}px` }}
      className="w-full bg-white text-slate-900 aspect-[210/297] overflow-y-auto font-sans"
    >
      <div className="grid grid-cols-[34%_66%] min-h-full">
        {/* Left column */}
        <div className="px-5 py-7 space-y-5" style={{ backgroundColor: SIDEBAR_BG }}>
          {(!!cv.email || !!cv.phone || !!cv.location || !!cv.links?.length) && (
            <div>
              <SideTitle accent={ACCENT}>Contact</SideTitle>
              <div className="space-y-1.5 text-[0.78em] text-slate-300 mt-2">
                {cv.email && (
                  <div className="flex items-center gap-1.5 break-all">
                    <Mail className="w-3 h-3 shrink-0" style={{ color: ACCENT }} />
                    {cv.email}
                  </div>
                )}
                {cv.phone && (
                  <div className="flex items-center gap-1.5">
                    <Phone className="w-3 h-3 shrink-0" style={{ color: ACCENT }} />
                    {cv.phone}
                  </div>
                )}
                {cv.location && (
                  <div className="flex items-center gap-1.5">
                    <MapPin className="w-3 h-3 shrink-0" style={{ color: ACCENT }} />
                    {cv.location}
                  </div>
                )}
                {cv.links?.map((link, idx) => (
                  <div key={idx} className="flex items-center gap-1.5 break-all">
                    <LinkIcon className="w-3 h-3 shrink-0" style={{ color: ACCENT }} />
                    {link.label || link.url}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!!cv.skillGroups?.length && (
            <div>
              <SideTitle accent={ACCENT}>Expertise technique</SideTitle>
              <div className="space-y-2 mt-2">
                {cv.skillGroups.map((group, idx) => (
                  <div key={idx}>
                    <p className="text-[0.72em] font-bold uppercase tracking-wide" style={{ color: ACCENT }}>
                      {group.label} :
                    </p>
                    <p className="text-[0.72em] text-slate-300 leading-relaxed">{group.items.join(', ')}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!!cv.languages?.length && (
            <div>
              <SideTitle accent={ACCENT}>Langues</SideTitle>
              <div className="space-y-1 mt-2">
                {cv.languages.map((lang, idx) => (
                  <p key={idx} className="text-[0.78em] text-slate-300">
                    {lang.name} : {lang.level}
                  </p>
                ))}
              </div>
            </div>
          )}

          {!!cv.interests?.length && (
            <div>
              <SideTitle accent={ACCENT}>Centres d'intérêt</SideTitle>
              <p className="text-[0.78em] text-slate-300 mt-2">{cv.interests.join(' · ')}</p>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className={`px-6 py-7 ${gap}`}>
          <div>
            <h1 className="text-[1.65em] font-bold leading-tight">{cv.fullName || 'Votre nom'}</h1>
            {cv.headline && (
              <p
                className="text-[0.85em] font-bold uppercase tracking-wide mt-1 pb-2.5 border-b-2 border-slate-200"
                style={{ color: ACCENT }}
              >
                {cv.headline}
              </p>
            )}
          </div>

          {cv.summary && <p className="text-[0.8em] leading-relaxed text-slate-600">{cv.summary}</p>}

          {!!cv.education?.length && (
            <div>
              <SectionTitle accent={ACCENT}>Education</SectionTitle>
              <div className={compact ? 'space-y-1.5' : 'space-y-2.5'}>
                {cv.education.map((edu, idx) => (
                  <div key={idx} className="flex gap-3">
                    <span className="text-[0.68em] font-bold text-slate-500 w-[28%] shrink-0 whitespace-nowrap">
                      {edu.period}
                    </span>
                    <div>
                      <p className="font-bold text-[0.84em]">{edu.school}</p>
                      <p className="text-[0.76em] text-slate-500">
                        {[edu.degree, edu.location].filter(Boolean).join(' — ')}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!!cv.experiences?.length && (
            <div>
              <SectionTitle accent={ACCENT}>Expérience professionnelle</SectionTitle>
              <div className={compact ? 'space-y-2.5' : 'space-y-4'}>
                {cv.experiences.map((exp, idx) => (
                  <div key={idx}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-bold text-[0.86em] flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: ACCENT }} />
                        {[exp.company, exp.location].filter(Boolean).join(' - ')}
                      </p>
                      {exp.period && (
                        <span className="text-[0.68em] font-bold text-slate-500 whitespace-nowrap">
                          {exp.period}
                        </span>
                      )}
                    </div>
                    {exp.role && (
                      <p className="text-[0.8em] font-bold mt-1 mb-1" style={{ color: ACCENT }}>
                        {exp.role}
                      </p>
                    )}
                    <ul className="space-y-0.5">
                      {exp.bullets?.map((bullet, bidx) => (
                        <li key={bidx} className="text-[0.78em] text-slate-600 leading-snug pl-3 relative">
                          <span className="absolute left-0" style={{ color: ACCENT }}>
                            •
                          </span>
                          {bullet}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!!cv.projects?.length && (
            <div>
              <SectionTitle accent={ACCENT}>Projets perso réalisés</SectionTitle>
              <div className={compact ? 'space-y-2' : 'space-y-3'}>
                {cv.projects.map((proj, idx) => (
                  <div key={idx}>
                    <div className="flex justify-between items-baseline gap-2">
                      <p className="font-bold text-[0.86em]">{proj.name}</p>
                      {proj.period && <span className="text-[0.7em] text-slate-400">{proj.period}</span>}
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {proj.bullets?.map((bullet, bidx) => (
                        <li key={bidx} className="text-[0.78em] text-slate-600 leading-snug pl-3 relative">
                          <span className="absolute left-0" style={{ color: ACCENT }}>
                            •
                          </span>
                          {bullet}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!!cv.certifications?.length && (
            <div>
              <SectionTitle accent={ACCENT}>Certificats</SectionTitle>
              <div className={compact ? 'space-y-1' : 'space-y-1.5'}>
                {cv.certifications.map((cert, idx) => (
                  <div key={idx} className="flex justify-between items-baseline gap-2">
                    <p className="text-[0.8em] font-bold" style={{ color: ACCENT }}>
                      {cert.name}
                      {cert.issuer && <span className="text-slate-500 font-normal"> — {cert.issuer}</span>}
                    </p>
                    {cert.date && (
                      <span className="text-[0.7em] text-slate-400 whitespace-nowrap">{cert.date}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SideTitle({ children, accent }: { children: React.ReactNode; accent: string }) {
  return (
    <p
      className="text-[0.75em] font-bold uppercase tracking-wider text-slate-50 pb-1.5 border-b"
      style={{ borderColor: accent }}
    >
      {children}
    </p>
  );
}

function SectionTitle({ children, accent }: { children: React.ReactNode; accent: string }) {
  return (
    <p className="text-[0.82em] font-bold uppercase tracking-wide border-b-2 pb-1.5 mb-2.5" style={{ borderColor: accent }}>
      {children}
    </p>
  );
}
