'use client';

import React from 'react';
import { useCVStore } from '@/lib/cv-store';
import { useForm } from 'react-hook-form';

const ACCENT_PRESETS = ['#2d5bff', '#0d9488', '#ea580c', '#7c3aed', '#dc2626', '#16a34a', '#334155'];

export default function IdentiteSection() {
  const { cv, saving, updateCV } = useCVStore();
  const { register, watch, setValue, handleSubmit } = useForm({
    defaultValues: cv || {},
  });

  const formData = watch();

  const onSubmit = async () => {
    // `defaultValues` was seeded from the full stored CV (which includes
    // `id`), and react-hook-form's watch() carries unregistered defaultValue
    // keys straight through — strip it before sending, the API rejects any
    // property it doesn't recognize.
    const { id, ...rest } = formData as Record<string, any>;
    await updateCV(rest);
  };

  // Appearance controls (template, accent) apply instantly — both to the
  // form state (so the picker highlights correctly) and to the server, so
  // the preview updates immediately instead of waiting for "Enregistrer".
  const applyAppearance = (partial: Record<string, any>) => {
    const nextOptions = { ...formData.options, ...partial };
    setValue('options', nextOptions, { shouldDirty: true });
    updateCV({ options: nextOptions } as any);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="form-control">
          <label className="label">
            <span className="label-text">Nom complet</span>
          </label>
          <input
            type="text"
            placeholder="Jean Dupont"
            className="input input-bordered"
            {...register('fullName')}
          />
        </div>
        <div className="form-control">
          <label className="label">
            <span className="label-text">Titre</span>
          </label>
          <input
            type="text"
            placeholder="Ingénieur Logiciel Senior"
            className="input input-bordered"
            {...register('headline')}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="form-control">
          <label className="label">
            <span className="label-text">Email</span>
          </label>
          <input
            type="email"
            placeholder="jean@example.com"
            className="input input-bordered"
            {...register('email')}
          />
        </div>
        <div className="form-control">
          <label className="label">
            <span className="label-text">Téléphone</span>
          </label>
          <input
            type="tel"
            placeholder="+33 6 12 34 56 78"
            className="input input-bordered"
            {...register('phone')}
          />
        </div>
      </div>

      <div className="form-control">
        <label className="label">
          <span className="label-text">Localisation</span>
        </label>
        <input
          type="text"
          placeholder="Paris, France"
          className="input input-bordered"
          {...register('location')}
        />
      </div>

      <div className="form-control">
        <label className="label">
          <span className="label-text">En bref (2 à 3 phrases)</span>
        </label>
        <textarea
          placeholder="Résumez votre profil en quelques phrases..."
          className="textarea textarea-bordered h-24"
          {...register('summary')}
        />
      </div>

      <div className="divider text-sm text-base-content/40">Contexte pour l'IA</div>
      <p className="text-xs text-base-content/40 -mt-2">
        N'apparaît jamais sur le CV — utilisé uniquement pour enrichir les lettres de motivation et
        analyses générées par l'IA.
      </p>

      <div className="form-control">
        <label className="label">
          <span className="label-text">Nom d'utilisateur GitHub</span>
        </label>
        <input
          type="text"
          placeholder="ousseynoukone"
          className="input input-bordered"
          {...register('githubUsername')}
        />
      </div>

      <div className="form-control">
        <label className="label">
          <span className="label-text">Informations complémentaires</span>
        </label>
        <textarea
          placeholder="Tout ce qui ne rentre pas dans le CV mais qui pourrait aider l'IA : contexte sur un projet, une réalisation précise, une préférence..."
          className="textarea textarea-bordered h-24"
          {...register('additionalContext')}
        />
      </div>

      <div className="flex items-center gap-2">
        <div className="divider text-sm text-base-content/40 flex-1 mb-0">Apparence</div>
        {saving && (
          <span className="text-xs text-base-content/40 flex items-center gap-1.5 shrink-0">
            <span className="loading loading-spinner loading-xs" /> Enregistrement...
          </span>
        )}
      </div>
      <p className="text-xs text-base-content/40 -mt-2">
        Le modèle et la couleur s'appliquent immédiatement, sans besoin d'enregistrer.
      </p>

      <div className="form-control">
        <label className="label">
          <span className="label-text">Modèle de CV</span>
        </label>
        <div className="flex gap-2">
          <label
            className={`flex-1 p-3 rounded-xl border cursor-pointer transition-colors ${
              (formData.options?.template ?? 'sidebar') === 'sidebar'
                ? 'border-primary bg-primary/10'
                : 'border-base-300'
            }`}
          >
            <input
              type="radio"
              value="sidebar"
              className="hidden"
              {...register('options.template', {
                onChange: (e) => applyAppearance({ template: e.target.value }),
              })}
            />
            <p className="text-sm font-medium">Visuel</p>
            <p className="text-xs text-base-content/50 mt-0.5">
              Deux colonnes avec icônes, pour une lecture humaine.
            </p>
          </label>
          <label
            className={`flex-1 p-3 rounded-xl border cursor-pointer transition-colors ${
              formData.options?.template === 'ats' ? 'border-primary bg-primary/10' : 'border-base-300'
            }`}
          >
            <input
              type="radio"
              value="ats"
              className="hidden"
              {...register('options.template', {
                onChange: (e) => applyAppearance({ template: e.target.value }),
              })}
            />
            <p className="text-sm font-medium">ATS-friendly</p>
            <p className="text-xs text-base-content/50 mt-0.5">
              Une colonne, texte brut, pensé pour les logiciels de tri de CV.
            </p>
          </label>
        </div>
      </div>

      <div className="form-control">
        <label className="label">
          <span className="label-text">Couleur d'accent</span>
        </label>
        <div className="flex items-center gap-2">
          {ACCENT_PRESETS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => applyAppearance({ accent: color })}
              className={`w-7 h-7 rounded-full ring-offset-2 ring-offset-base-200 transition-all ${
                formData.options?.accent === color ? 'ring-2 ring-base-content' : ''
              }`}
              style={{ backgroundColor: color }}
              aria-label={color}
            />
          ))}
          <input
            type="color"
            className="w-9 h-9 rounded-lg border border-base-300 cursor-pointer ml-1"
            {...register('options.accent', {
              onChange: (e) => applyAppearance({ accent: e.target.value }),
            })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="form-control">
          <label className="label">
            <span className="label-text">Taille de police</span>
          </label>
          <input
            type="number"
            step="0.1"
            min={9}
            max={16}
            className="input input-bordered"
            {...register('options.fontSize', { valueAsNumber: true })}
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer self-end mb-3">
          <input type="checkbox" className="toggle toggle-primary" {...register('options.compact')} />
          <span className="text-sm">Compact</span>
        </label>
      </div>

      <button type="submit" className="btn btn-primary">
        Enregistrer
      </button>
    </form>
  );
}
