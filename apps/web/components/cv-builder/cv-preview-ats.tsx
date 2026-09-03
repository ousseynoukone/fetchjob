'use client';

import React from 'react';
import { useCVStore } from '@/lib/cv-store';
import { renderInlineLinks } from '@/lib/inline-links';

export default function CVPreviewAts() {
  const { cv } = useCVStore();
  if (!cv) return null;

  const fontSize = cv.options?.fontSize || 11;
  const contactTextParts = [cv.email, cv.phone, cv.location].filter(Boolean);

  return (
    <div
      style={{ fontSize: `${fontSize}px` }}
      className="w-full bg-white text-black aspect-[210/297] overflow-y-auto px-8 py-7 font-sans"
    >
      <h1 className="text-[1.7em] font-bold">{cv.fullName || 'Votre nom'}</h1>
      {cv.headline && <p className="text-[1.05em] mt-0.5">{cv.headline}</p>}
      {(!!contactTextParts.length || !!cv.links?.length) && (
        <p className="text-[0.85em] mt-1.5 text-neutral-800 space-x-1">
          {contactTextParts.map((part, i) => (
            <span key={i}>
              {i > 0 ? ' | ' : ''}
              {part}
            </span>
          ))}
          {cv.links?.map((link, idx) => (
            <span key={idx}>
              {(idx > 0 || contactTextParts.length) ? ' | ' : ''}
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="underline">
                {link.label || link.url}
              </a>
            </span>
          ))}
        </p>
      )}

      {cv.summary && (
        <Section title="Résumé">
          <p className="text-[0.9em] leading-relaxed">{cv.summary}</p>
        </Section>
      )}

      {!!cv.experiences?.length && (
        <Section title="Expérience professionnelle">
          {cv.experiences.map((exp, idx) => (
            <div key={idx} className="mb-3">
              <p className="text-[0.95em] font-bold">
                {exp.role} — {renderInlineLinks(exp.company)}
              </p>
              <p className="text-[0.85em] mt-0.5">{[exp.location, exp.period].filter(Boolean).join(' | ')}</p>
              <ul className="mt-1 space-y-0.5">
                {exp.bullets?.map((bullet, bidx) => (
                  <li key={bidx} className="text-[0.88em] leading-snug pl-3 relative before:content-['-'] before:absolute before:left-0">
                    {bullet}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      )}

      {!!cv.projects?.length && (
        <Section title="Projets">
          {cv.projects.map((proj, idx) => (
            <div key={idx} className="mb-3">
              <p className="text-[0.95em] font-bold">
                {proj.url ? (
                  <a href={proj.url} target="_blank" rel="noopener noreferrer" className="underline">
                    {proj.name}
                  </a>
                ) : (
                  proj.name
                )}
                {proj.period ? ` — ${proj.period}` : ''}
              </p>
              <ul className="mt-1 space-y-0.5">
                {proj.bullets?.map((bullet, bidx) => (
                  <li key={bidx} className="text-[0.88em] leading-snug pl-3 relative before:content-['-'] before:absolute before:left-0">
                    {bullet}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      )}

      {!!cv.education?.length && (
        <Section title="Formation">
          {cv.education.map((edu, idx) => (
            <div key={idx} className="mb-3">
              <p className="text-[0.95em] font-bold">{edu.degree}</p>
              <p className="text-[0.88em] mt-0.5">
                {edu.link ? (
                  <a href={edu.link} target="_blank" rel="noopener noreferrer" className="underline">
                    {edu.school}
                  </a>
                ) : (
                  edu.school
                )}
                {[edu.location, edu.period].filter(Boolean).length
                  ? ` | ${[edu.location, edu.period].filter(Boolean).join(' | ')}`
                  : ''}
              </p>
            </div>
          ))}
        </Section>
      )}

      {!!cv.skillGroups?.length && (
        <Section title="Compétences">
          {cv.skillGroups.map((group, idx) => (
            <p key={idx} className="text-[0.88em] mb-1">
              <span className="font-bold">{group.label}: </span>
              {group.items.join(', ')}
            </p>
          ))}
        </Section>
      )}

      {!!cv.certifications?.length && (
        <Section title="Certifications">
          {cv.certifications.map((cert, idx) => (
            <p key={idx} className="text-[0.88em] mb-0.5">
              {cert.url ? (
                <a href={cert.url} target="_blank" rel="noopener noreferrer" className="underline">
                  {cert.name}
                </a>
              ) : (
                cert.name
              )}{' '}
              — {cert.issuer} ({cert.date})
            </p>
          ))}
        </Section>
      )}

      {!!cv.languages?.length && (
        <Section title="Langues">
          <p className="text-[0.88em]">{cv.languages.map((l) => `${l.name} (${l.level})`).join(', ')}</p>
        </Section>
      )}

      {!!cv.interests?.length && (
        <Section title="Centres d'intérêt">
          <p className="text-[0.88em]">{cv.interests.join(', ')}</p>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="text-[0.95em] font-bold uppercase border-b border-black pb-1 mb-2">{title}</p>
      {children}
    </div>
  );
}
