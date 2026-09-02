'use client';

import React, { useState } from 'react';
import { useCVStore } from '@/lib/cv-store';
import { Plus, Trash2 } from 'lucide-react';

export default function CertificationsSection() {
  const { cv, saving, updateCV } = useCVStore();
  const [certifications, setCertifications] = useState(cv?.certifications || []);

  const addCertification = () => {
    setCertifications([...certifications, { name: '', issuer: '', date: '' }]);
  };

  const updateCertification = (idx: number, field: string, value: any) => {
    const updated = [...certifications];
    updated[idx] = { ...updated[idx], [field]: value };
    setCertifications(updated);
  };

  const removeCertification = (idx: number) => {
    setCertifications(certifications.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    await updateCV({ certifications });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {certifications.map((cert, idx) => (
          <div key={idx} className="bg-base-100 border border-base-300 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 grid grid-cols-3 gap-2">
                <input
                  type="text"
                  placeholder="Nom de la certification"
                  value={cert.name}
                  onChange={(e) => updateCertification(idx, 'name', e.target.value)}
                  className="input input-bordered input-sm"
                />
                <input
                  type="text"
                  placeholder="Émetteur"
                  value={cert.issuer}
                  onChange={(e) => updateCertification(idx, 'issuer', e.target.value)}
                  className="input input-bordered input-sm"
                />
                <input
                  type="text"
                  placeholder="Date"
                  value={cert.date}
                  onChange={(e) => updateCertification(idx, 'date', e.target.value)}
                  className="input input-bordered input-sm"
                />
              </div>
              <button
                type="button"
                onClick={() => removeCertification(idx)}
                className="btn btn-ghost btn-sm btn-circle text-error shrink-0"
                aria-label="Supprimer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {certifications.length === 0 && (
          <p className="text-sm text-base-content/40 text-center py-6">Aucune certification ajoutée.</p>
        )}
      </div>

      <button type="button" onClick={addCertification} className="btn btn-outline btn-sm gap-2">
        <Plus className="w-4 h-4" /> Ajouter une certification
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
