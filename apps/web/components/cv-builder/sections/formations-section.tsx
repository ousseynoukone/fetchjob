'use client';

import React, { useState } from 'react';
import { useCVStore } from '@/lib/cv-store';
import { Plus, Trash2 } from 'lucide-react';

export default function FormationsSection() {
  const { cv, saving, updateCV } = useCVStore();
  const [education, setEducation] = useState(cv?.education || []);

  const addEducation = () => {
    setEducation([
      ...education,
      { degree: '', school: '', location: '', period: '', precision: '' },
    ]);
  };

  const updateEducation = (idx: number, field: string, value: any) => {
    const updated = [...education];
    updated[idx] = { ...updated[idx], [field]: value };
    setEducation(updated);
  };

  const removeEducation = (idx: number) => {
    setEducation(education.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    await updateCV({ education });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {education.map((edu, idx) => (
          <div key={idx} className="bg-base-100 border border-base-300 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Diplôme"
                    value={edu.degree}
                    onChange={(e) => updateEducation(idx, 'degree', e.target.value)}
                    className="input input-bordered input-sm"
                  />
                  <input
                    type="text"
                    placeholder="École / Université"
                    value={edu.school}
                    onChange={(e) => updateEducation(idx, 'school', e.target.value)}
                    className="input input-bordered input-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Lieu"
                    value={edu.location}
                    onChange={(e) => updateEducation(idx, 'location', e.target.value)}
                    className="input input-bordered input-sm"
                  />
                  <input
                    type="text"
                    placeholder="Période"
                    value={edu.period}
                    onChange={(e) => updateEducation(idx, 'period', e.target.value)}
                    className="input input-bordered input-sm"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeEducation(idx)}
                className="btn btn-ghost btn-sm btn-circle text-error shrink-0"
                aria-label="Supprimer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {education.length === 0 && (
          <p className="text-sm text-base-content/40 text-center py-6">Aucune formation ajoutée.</p>
        )}
      </div>

      <button type="button" onClick={addEducation} className="btn btn-outline btn-sm gap-2">
        <Plus className="w-4 h-4" /> Ajouter une formation
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
