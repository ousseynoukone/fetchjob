'use client';

import React, { useState } from 'react';
import { useCVStore } from '@/lib/cv-store';
import { Plus, Trash2 } from 'lucide-react';

export default function ProjetsSection() {
  const { cv, saving, updateCV } = useCVStore();
  const [projects, setProjects] = useState(cv?.projects || []);

  const addProject = () => {
    setProjects([...projects, { name: '', period: '', url: '', bullets: [] }]);
  };

  const updateProject = (idx: number, field: string, value: any) => {
    const updated = [...projects];
    updated[idx] = { ...updated[idx], [field]: value };
    setProjects(updated);
  };

  const removeProject = (idx: number) => {
    setProjects(projects.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    await updateCV({ projects });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {projects.map((proj, idx) => (
          <div key={idx} className="bg-base-100 border border-base-300 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 space-y-2">
                <input
                  type="text"
                  placeholder="Nom du projet"
                  value={proj.name}
                  onChange={(e) => updateProject(idx, 'name', e.target.value)}
                  className="input input-bordered input-sm w-full"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Période"
                    value={proj.period}
                    onChange={(e) => updateProject(idx, 'period', e.target.value)}
                    className="input input-bordered input-sm"
                  />
                  <input
                    type="url"
                    placeholder="URL du projet"
                    value={proj.url}
                    onChange={(e) => updateProject(idx, 'url', e.target.value)}
                    className="input input-bordered input-sm"
                  />
                </div>
                <textarea
                  placeholder="Points clés (un par ligne)"
                  value={proj.bullets.join('\n')}
                  onChange={(e) =>
                    updateProject(idx, 'bullets', e.target.value.split('\n').filter((b) => b.trim()))
                  }
                  className="textarea textarea-bordered textarea-sm w-full h-20"
                />
              </div>
              <button
                type="button"
                onClick={() => removeProject(idx)}
                className="btn btn-ghost btn-sm btn-circle text-error shrink-0"
                aria-label="Supprimer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {projects.length === 0 && (
          <p className="text-sm text-base-content/40 text-center py-6">Aucun projet ajouté.</p>
        )}
      </div>

      <button type="button" onClick={addProject} className="btn btn-outline btn-sm gap-2">
        <Plus className="w-4 h-4" /> Ajouter un projet
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
