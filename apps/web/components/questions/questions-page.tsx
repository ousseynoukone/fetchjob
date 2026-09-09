'use client';

import React, { useEffect, useState } from 'react';
import AppShell from '@/components/layout/app-shell';
import { useQuestionsStore, CustomQuestion } from '@/lib/questions-store';
import { HelpCircle, CheckCircle2, ExternalLink, Trash2 } from 'lucide-react';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function QuestionCard({ question }: { question: CustomQuestion }) {
  const { saving, setAnswer, clearAnswer } = useQuestionsStore();
  const [value, setValue] = useState(question.answer || '');
  const isSaving = saving === question.id;

  const handleSave = () => {
    if (!value.trim()) return;
    setAnswer(question.id, value.trim());
  };

  return (
    <div className="bg-base-200 border border-base-300 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <p className="font-medium">{question.questionText}</p>
          <div className="flex items-center gap-2 mt-1 text-xs text-base-content/40">
            <span className="badge badge-ghost badge-sm capitalize">{question.platform.replace('_', ' ')}</span>
            <span className="badge badge-ghost badge-sm">{question.fieldType}</span>
            <span>
              vu {question.occurrenceCount} fois · dernière fois le {formatDate(question.lastSeenAt)}
            </span>
          </div>
        </div>
        {question.answer && (
          <button
            className="btn btn-ghost btn-xs text-error shrink-0"
            onClick={() => clearAnswer(question.id)}
            title="Effacer la réponse"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {question.lastSourceUrl && (
        <a
          href={question.lastSourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary mb-3 hover:underline"
        >
          <ExternalLink className="w-3 h-3" /> Voir l'offre où elle est apparue
        </a>
      )}

      <div className="flex gap-2">
        {question.fieldType === 'select' || question.fieldType === 'radio' ? (
          <select
            className="select select-bordered select-sm flex-1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          >
            <option value="">Choisir une réponse...</option>
            {question.options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            className="input input-bordered input-sm flex-1"
            placeholder="Votre réponse..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <button className="btn btn-primary btn-sm" disabled={isSaving || !value.trim()} onClick={handleSave}>
          {question.answer ? 'Modifier' : 'Enregistrer'}
        </button>
      </div>
    </div>
  );
}

export default function QuestionsPage() {
  const { questions, loading, fetchList } = useQuestionsStore();

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const unanswered = questions.filter((q) => !q.answer);
  const answered = questions.filter((q) => q.answer);

  return (
    <AppShell>
      <div className="max-w-3xl mx-auto px-8 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Questions</h1>
          <p className="text-base-content/50 mt-1">
            Questions personnalisées rencontrées par l'auto-apply sans réponse connue. Répondez une
            fois — la même question (sur n'importe quelle plateforme) sera ensuite remplie
            automatiquement.
          </p>
        </div>

        {loading && !questions.length ? (
          <div className="flex justify-center py-20">
            <span className="loading loading-spinner loading-lg" />
          </div>
        ) : (
          <div className="space-y-8">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <HelpCircle className="w-4 h-4 text-warning" />
                <h2 className="font-semibold">À répondre ({unanswered.length})</h2>
              </div>
              {unanswered.length === 0 ? (
                <p className="text-sm text-base-content/40">
                  Aucune question en attente — l'auto-apply n'a rien rencontré qu'il ne sache pas remplir.
                </p>
              ) : (
                <div className="space-y-3">
                  {unanswered.map((q) => (
                    <QuestionCard key={q.id} question={q} />
                  ))}
                </div>
              )}
            </div>

            {answered.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle2 className="w-4 h-4 text-success" />
                  <h2 className="font-semibold">Déjà répondu ({answered.length})</h2>
                </div>
                <div className="space-y-3">
                  {answered.map((q) => (
                    <QuestionCard key={q.id} question={q} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
