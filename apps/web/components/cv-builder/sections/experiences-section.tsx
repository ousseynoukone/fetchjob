'use client';

import React, { useState } from 'react';
import { useCVStore } from '@/lib/cv-store';
import { Plus, Trash2 } from 'lucide-react';
import LinkableTextInput from '../linkable-text-input';

export default function ExperiencesSection() {
  const { cv, saving, updateCV } = useCVStore();
  const [experiences, setExperiences] = useState(cv?.experiences || []);

  const addExperience = () => {
    setExperiences([
      ...experiences,
      { role: '', company: '', location: '', period: '', bullets: [] },
    ]);
  };

  const updateExperience = (idx: number, field: string, value: any) => {
    const updated = [...experiences];
    updated[idx] = { ...updated[idx], [field]: value };
    setExperiences(updated);
  };

  const removeExperience = (idx: number) => {
    setExperiences(experiences.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    await updateCV({ experiences });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {experiences.map((exp, idx) => (
          <div key={idx} className="bg-base-100 border border-base-300 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Intitulé du poste"
                    value={exp.role}
                    onChange={(e) => updateExperience(idx, 'role', e.target.value)}
                    className="input input-bordered input-sm"
                  />
                  <LinkableTextInput
                    placeholder="Entreprise (sélectionnez le nom pour ajouter un lien)"
                    value={exp.company}
                    onChange={(value) => updateExperience(idx, 'company', value)}
                    className="input input-bordered input-sm w-full"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Lieu"
                    value={exp.location}
                    onChange={(e) => updateExperience(idx, 'location', e.target.value)}
                    className="input input-bordered input-sm"
                  />
                  <input
                    type="text"
                    placeholder="Période (ex : Jan 2020 - Déc 2022)"
                    value={exp.period}
                    onChange={(e) => updateExperience(idx, 'period', e.target.value)}
                    className="input input-bordered input-sm"
                  />
                </div>
                <textarea
                  placeholder="Points clés (un par ligne)"
                  value={exp.bullets.join('\n')}
                  onChange={(e) =>
                    updateExperience(idx, 'bullets', e.target.value.split('\n').filter((b) => b.trim()))
                  }
                  className="textarea textarea-bordered textarea-sm w-full h-20"
                />
              </div>
              <button
                type="button"
                onClick={() => removeExperience(idx)}
                className="btn btn-ghost btn-sm btn-circle text-error shrink-0"
                aria-label="Supprimer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {experiences.length === 0 && (
          <p className="text-sm text-base-content/40 text-center py-6">Aucune expérience ajoutée.</p>
        )}
      </div>

      <button type="button" onClick={addExperience} className="btn btn-outline btn-sm gap-2">
        <Plus className="w-4 h-4" /> Ajouter une expérience
      </button>

      <div className="pt-3 border-t border-base-300">
        <button onClick={handleSave} className="btn btn-primary btn-sm gap-2" disabled={saving}>
          {saving && <span className="loading loading-spinner loading-xs" />}
          Enregistrer
        </button>
      </div>
    </div>
  );
}
