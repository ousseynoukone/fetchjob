import { create } from 'zustand';
import apiClient from './api-client';
import { toast } from './toast-store';

export interface CustomQuestion {
  id: string;
  platform: string;
  questionText: string;
  fieldType: string;
  options: string[];
  answer: string | null;
  answeredAt: string | null;
  occurrenceCount: number;
  lastSeenAt: string;
  lastSourceUrl: string | null;
}

interface Store {
  questions: CustomQuestion[];
  loading: boolean;
  saving: string | null; // id currently being saved
  unansweredCount: number;
  pollHandle: ReturnType<typeof setInterval> | null;
  fetchList: () => Promise<void>;
  setAnswer: (id: string, answer: string) => Promise<void>;
  clearAnswer: (id: string) => Promise<void>;
  fetchCount: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

// Same polling shape as updates-store.ts's unseen-count badge.
const POLL_INTERVAL_MS = 45_000;

export const useQuestionsStore = create<Store>((set, get) => ({
  questions: [],
  loading: false,
  saving: null,
  unansweredCount: 0,
  pollHandle: null,

  fetchList: async () => {
    try {
      set({ loading: true });
      const response = await apiClient.get('/api/questions');
      set({ questions: response.data, loading: false });
    } catch (error: any) {
      set({ loading: false });
      toast.error(error.response?.data?.message || 'Échec du chargement des questions');
    }
  },

  setAnswer: async (id, answer) => {
    const wasUnanswered = get().questions.find((q) => q.id === id)?.answer == null;
    try {
      set({ saving: id });
      const response = await apiClient.put(`/api/questions/${id}/answer`, { answer });
      set((s) => ({
        questions: s.questions.map((q) => (q.id === id ? response.data : q)),
        saving: null,
        unansweredCount: wasUnanswered ? Math.max(0, s.unansweredCount - 1) : s.unansweredCount,
      }));
      toast.success('Réponse enregistrée');
    } catch (error: any) {
      set({ saving: null });
      toast.error(error.response?.data?.message || "Échec de l'enregistrement");
    }
  },

  clearAnswer: async (id) => {
    const wasAnswered = get().questions.find((q) => q.id === id)?.answer != null;
    try {
      const response = await apiClient.delete(`/api/questions/${id}/answer`);
      set((s) => ({
        questions: s.questions.map((q) => (q.id === id ? response.data : q)),
        unansweredCount: wasAnswered ? s.unansweredCount + 1 : s.unansweredCount,
      }));
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Échec de la suppression');
    }
  },

  fetchCount: async () => {
    try {
      const res = await apiClient.get('/api/questions/count');
      set({ unansweredCount: res.data.count });
    } catch {
      // Silent — a failed badge poll shouldn't interrupt the rest of the app.
    }
  },

  startPolling: () => {
    if (get().pollHandle) return;
    get().fetchCount();
    const handle = setInterval(() => get().fetchCount(), POLL_INTERVAL_MS);
    set({ pollHandle: handle });
  },

  stopPolling: () => {
    const handle = get().pollHandle;
    if (handle) clearInterval(handle);
    set({ pollHandle: null });
  },
}));
