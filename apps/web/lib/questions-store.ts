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
  fetchList: () => Promise<void>;
  setAnswer: (id: string, answer: string) => Promise<void>;
  clearAnswer: (id: string) => Promise<void>;
}

export const useQuestionsStore = create<Store>((set, get) => ({
  questions: [],
  loading: false,
  saving: null,

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
    try {
      set({ saving: id });
      const response = await apiClient.put(`/api/questions/${id}/answer`, { answer });
      set({
        questions: get().questions.map((q) => (q.id === id ? response.data : q)),
        saving: null,
      });
      toast.success('Réponse enregistrée');
    } catch (error: any) {
      set({ saving: null });
      toast.error(error.response?.data?.message || "Échec de l'enregistrement");
    }
  },

  clearAnswer: async (id) => {
    try {
      const response = await apiClient.delete(`/api/questions/${id}/answer`);
      set({ questions: get().questions.map((q) => (q.id === id ? response.data : q)) });
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Échec de la suppression');
    }
  },
}));
