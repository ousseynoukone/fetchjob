'use client';

import React, { useState } from 'react';
import { useCVStore } from '@/lib/cv-store';
import { Plus, Trash2 } from 'lucide-react';

export default function CompetencesSection() {
  const { cv, saving, updateCV } = useCVStore();
  const [skillGroups, setSkillGroups] = useState(cv?.skillGroups || []);

  const addSkillGroup = () => {
    setSkillGroups([...skillGroups, { label: '', items: [] }]);
  };

  const updateSkillGroup = (idx: number, field: string, value: any) => {
    const updated = [...skillGroups];
    updated[idx] = { ...updated[idx], [field]: value };
    setSkillGroups(updated);
  };

  const removeSkillGroup = (idx: number) => {
    setSkillGroups(skillGroups.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    await updateCV({ skillGroups });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {skillGroups.map((group, idx) => (
          <div key={idx} className="bg-base-100 border border-base-300 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 space-y-2">
                <input
                  type="text"
                  placeholder="Catégorie (ex : Langages)"
                  value={group.label}
                  onChange={(e) => updateSkillGroup(idx, 'label', e.target.value)}
                  className="input input-bordered input-sm w-full"
                />
                <textarea
                  placeholder="Compétences séparées par des virgules"
                  value={group.items.join(', ')}
                  onChange={(e) =>
                    updateSkillGroup(idx, 'items', e.target.value.split(',').map((s) => s.trim()))
                  }
                  className="textarea textarea-bordered textarea-sm w-full h-16"
                />
              </div>
              <button
                type="button"
                onClick={() => removeSkillGroup(idx)}
                className="btn btn-ghost btn-sm btn-circle text-error shrink-0"
                aria-label="Supprimer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {skillGroups.length === 0 && (
          <p className="text-sm text-base-content/40 text-center py-6">Aucune compétence ajoutée.</p>
        )}
      </div>

      <button type="button" onClick={addSkillGroup} className="btn btn-outline btn-sm gap-2">
        <Plus className="w-4 h-4" /> Ajouter une catégorie
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
