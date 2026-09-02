'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import apiClient from '@/lib/api-client';
import { toast } from '@/lib/toast-store';
import { X } from 'lucide-react';

export default function AddOfferModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState({ title: '', company: '', location: '', url: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const response = await apiClient.post('/api/candidatures/manual', form);
      onClose();
      toast.success('Offre ajoutée');
      router.push(`/candidatures/${response.data.id}`);
    } catch (err: any) {
      setError(err.response?.data?.message || "Impossible d'ajouter cette offre");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div
        className="bg-base-200 border border-base-300 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-1">
          <h2 className="text-lg font-semibold">Ajouter une offre</h2>
          <button onClick={onClose} className="btn btn-ghost btn-sm btn-circle">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-base-content/50 mb-5">
          Copiez-collez le contenu d'une offre trouvée sur LinkedIn, HelloWork ou ailleurs. Elle sera
          notée par rapport à votre CV et vous pourrez générer un CV adapté et une lettre de motivation.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          {error && (
            <div className="alert alert-error text-sm py-2">
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <input
              className="input input-bordered input-sm"
              placeholder="Titre du poste"
              required
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
            <input
              className="input input-bordered input-sm"
              placeholder="Entreprise"
              required
              value={form.company}
              onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
            />
          </div>

          <input
            className="input input-bordered input-sm w-full"
            placeholder="Localisation (optionnel)"
            value={form.location}
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
          />

          <input
            className="input input-bordered input-sm w-full"
            placeholder="URL de l'offre (linkedin.com/jobs/... ou hellowork.com/...)"
            type="url"
            required
            value={form.url}
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
          />

          <textarea
            className="textarea textarea-bordered w-full h-40 text-sm"
            placeholder="Collez ici la description complète de l'offre"
            required
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />

          <button type="submit" className="btn btn-primary w-full" disabled={saving}>
            {saving ? 'Ajout...' : 'Ajouter et noter cette offre'}
          </button>
        </form>
      </div>
    </div>
  );
}
