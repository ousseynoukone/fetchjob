'use client';

import React from 'react';
import { useCVStore } from '@/lib/cv-store';
import CVPreviewAts from './cv-preview-ats';
import { Mail, Phone, MapPin, Building2, Calendar, Link as LinkIcon } from 'lucide-react';

const DEFAULT_ACCENT = '#2d5bff';

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
        <div className="px-5 py-7 space-y-5 border-r border-slate-100">
          <div>
            <h1 className="text-[1.55em] font-bold leading-tight">{cv.fullName || 'Votre nom'}</h1>
            {cv.headline && (
              <p className="text-[0.8em] font-semibold uppercase tracking-wide mt-1" style={{ color: ACCENT }}>
                {cv.headline}
              </p>
            )}
          </div>

          {(!!cv.email || !!cv.phone || !!cv.location || !!cv.links?.length) && (
            <div className="space-y-1.5 text-[0.78em] text-slate-600">
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
          )}

          {!!cv.skillGroups?.length && (
            <div>
              <SideTitle>Compétences</SideTitle>
              <div className="space-y-2.5 mt-2">
                {cv.skillGroups.map((group, idx) => (
                  <div key={idx}>
                    <p className="text-[0.72em] font-bold uppercase tracking-wide text-slate-500 mb-1">
                      {group.label}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {group.items.map((item, i) => (
                        <span
                          key={i}
                          className="text-[0.7em] rounded px-1.5 py-0.5 bg-slate-100 text-slate-700"
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!!cv.languages?.length && (
            <div>
              <SideTitle>Langues</SideTitle>
              <div className="space-y-1 mt-2">
                {cv.languages.map((lang, idx) => (
                  <p key={idx} className="text-[0.78em] text-slate-700">
                    <span className="font-semibold">{lang.name}</span>{' '}
                    <span className="text-slate-500">— {lang.level}</span>
                  </p>
                ))}
              </div>
            </div>
          )}

          {!!cv.certifications?.length && (
            <div>
              <SideTitle>Certifications</SideTitle>
              <div className="space-y-1 mt-2">
                {cv.certifications.map((cert, idx) => (
                  <p key={idx} className="text-[0.76em] text-slate-700 leading-snug">
                    {cert.name} <span className="text-slate-500">— {cert.issuer}</span>
                  </p>
                ))}
              </div>
            </div>
          )}

          {!!cv.interests?.length && (
            <div>
              <SideTitle>Centres d'intérêt</SideTitle>
              <p className="text-[0.78em] text-slate-600 mt-2">{cv.interests.join(' · ')}</p>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className={`px-6 py-7 ${gap}`}>
          {cv.summary && <p className="text-[0.8em] leading-relaxed text-slate-600">{cv.summary}</p>}

          {!!cv.experiences?.length && (
            <div>
              <SectionTitle>Expériences professionnelles</SectionTitle>
              <div className={compact ? 'space-y-2.5' : 'space-y-4'}>
                {cv.experiences.map((exp, idx) => (
                  <div key={idx}>
                    <p className="font-bold text-[0.9em]">{exp.role}</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.7em] text-slate-500 mt-0.5">
                      {exp.company && (
                        <span className="flex items-center gap-1">
                          <Building2 className="w-2.5 h-2.5" /> {exp.company}
                        </span>
                      )}
                      {exp.location && (
                        <span className="flex items-center gap-1">
                          <MapPin className="w-2.5 h-2.5" /> {exp.location}
                        </span>
                      )}
                      {exp.period && (
                        <span className="flex items-center gap-1">
                          <Calendar className="w-2.5 h-2.5" /> {exp.period}
                        </span>
                      )}
                    </div>
                    <ul className="mt-1.5 space-y-0.5">
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
              <SectionTitle>Projets</SectionTitle>
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

          {!!cv.education?.length && (
            <div>
              <SectionTitle>Formation</SectionTitle>
              <div className={compact ? 'space-y-1.5' : 'space-y-2.5'}>
                {cv.education.map((edu, idx) => (
                  <div key={idx} className="flex justify-between items-baseline gap-2">
                    <div>
                      <p className="font-bold text-[0.84em]">{edu.degree}</p>
                      <p className="text-[0.76em] text-slate-500">{edu.school}</p>
                    </div>
                    <span className="text-[0.7em] text-slate-400 whitespace-nowrap">{edu.period}</span>
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

function SideTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[0.72em] font-bold uppercase tracking-wider text-slate-400">{children}</p>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[0.82em] font-bold uppercase tracking-wide border-b border-slate-200 pb-1.5 mb-2.5">
      {children}
    </p>
  );
}
