'use client';

import React, { useState } from 'react';
import { useCVStore } from '@/lib/cv-store';
import { Plus, Trash2 } from 'lucide-react';

const PROFICIENCY_LEVELS = [
  'Débutant',
  'Élémentaire',
  'Intermédiaire',
  'Avancé',
  'Courant',
  'Bilingue',
  'Langue maternelle',
];

export default function LanguesSection() {
  const { saving, updateCV, cv } = useCVStore();
  const [languages, setLanguages] = useState(cv?.languages || []);

  const addLanguage = () => {
    setLanguages([...languages, { name: '', level: '' }]);
  };

  const updateLanguage = (idx: number, field: string, value: any) => {
    const updated = [...languages];
    updated[idx] = { ...updated[idx], [field]: value };
    setLanguages(updated);
  };

  const removeLanguage = (idx: number) => {
    setLanguages(languages.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    await updateCV({ languages });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {languages.map((lang, idx) => (
          <div key={idx} className="bg-base-100 border border-base-300 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 grid grid-cols-2 gap-3">
                <input
                  type="text"
                  placeholder="Langue"
                  value={lang.name}
                  onChange={(e) => updateLanguage(idx, 'name', e.target.value)}
                  className="input input-bordered input-sm"
                />
                <select
                  value={lang.level}
                  onChange={(e) => updateLanguage(idx, 'level', e.target.value)}
                  className="select select-bordered select-sm"
                >
                  <option disabled value="">
                    Niveau
                  </option>
                  {PROFICIENCY_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => removeLanguage(idx)}
                className="btn btn-ghost btn-sm btn-circle text-error shrink-0"
                aria-label="Supprimer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {languages.length === 0 && (
          <p className="text-sm text-base-content/40 text-center py-6">Aucune langue ajoutée.</p>
        )}
      </div>

      <button type="button" onClick={addLanguage} className="btn btn-outline btn-sm gap-2">
        <Plus className="w-4 h-4" /> Ajouter une langue
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
