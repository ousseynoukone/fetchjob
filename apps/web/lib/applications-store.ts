import { create } from 'zustand';
import apiClient from './api-client';
import { toast } from './toast-store';

export interface JobOffer {
  id: string;
  title: string;
  company: string;
  location?: string;
  description: string;
  url: string;
  contractType?: string;
  salary?: string;
  source: string;
  postedAt?: string;
  scrapedAt?: string;
}

export interface Application {
  id: string;
  jobTitle: string;
  company: string;
  location?: string;
  sourceUrl: string;
  matchScore: number;
  matchedSkills: string[];
  missingSkills: string[];
  aiAnalysis?: { strengths?: string[]; gaps?: string[]; advice?: string; recommendation?: number };
  status: string;
  coverLetter?: string;
  autoApplyNote?: string;
  verifiedAt?: string;
  verificationNote?: string;
  screenshotTakenAt?: string;
  appliedAt?: string;
  createdAt: string;
  jobOffer: JobOffer;
}

interface Store {
  applications: Application[];
  current: Application | null;
  loading: boolean;
  error: string | null;
  fetchList: (status?: string, scope?: 'current' | 'history') => Promise<void>;
  fetchById: (id: string) => Promise<void>;
  updateStatus: (id: string, status: string) => Promise<void>;
  markApplied: (id: string) => Promise<void>;
  retryOne: (id: string) => Promise<void>;
  regenerate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeAll: (status?: string, scope?: 'current' | 'history') => Promise<void>;
}

export const useApplicationsStore = create<Store>((set, get) => ({
  applications: [],
  current: null,
  loading: false,
  error: null,

  fetchList: async (status, scope) => {
    try {
      set({ loading: true, error: null });
      const response = await apiClient.get('/api/candidatures', {
        params: { ...(status ? { status } : {}), ...(scope ? { scope } : {}) },
      });
      set({ applications: response.data, loading: false });
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to fetch applications';
      set({ error: message, loading: false });
      toast.error(message);
    }
  },

  fetchById: async (id) => {
    try {
      set({ loading: true, error: null });
      const response = await apiClient.get(`/api/candidatures/${id}`);
      set({ current: response.data, loading: false });
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to fetch application', loading: false });
    }
  },

  updateStatus: async (id, status) => {
    try {
      const response = await apiClient.patch(`/api/candidatures/${id}/status`, { status });
      set({ current: response.data });
      set({ applications: get().applications.map((a) => (a.id === id ? { ...a, status } : a)) });
      toast.success('Statut mis à jour');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to update status');
      throw error;
    }
  },

  markApplied: async (id) => {
    try {
      const response = await apiClient.post(`/api/candidatures/${id}/apply`);
      set({ current: response.data });
      set({
        applications: get().applications.map((a) =>
          a.id === id ? { ...a, status: 'applied', appliedAt: response.data.appliedAt } : a,
        ),
      });
      toast.success('Candidature marquée comme envoyée');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to mark as applied');
      throw error;
    }
  },

  regenerate: async (id) => {
    try {
      set({ loading: true, error: null });
      const response = await apiClient.post(`/api/candidatures/${id}/regen`);
      set({ current: response.data, loading: false });
      toast.success('Candidature régénérée');
    } catch (error: any) {
      const message = error.response?.data?.message || 'La génération IA a échoué.';
      set({ error: message, loading: false });
      toast.error(message);
      throw error;
    }
  },

  remove: async (id) => {
    try {
      await apiClient.delete(`/api/candidatures/${id}`);
      set({ applications: get().applications.filter((a) => a.id !== id) });
      toast.success('Candidature supprimée');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to delete application');
      throw error;
    }
  },

  // Re-fetches with the same status/scope afterwards rather than filtering
  // the local list in place — `scope` (current run vs. history, for
  // "à postuler") can't be replicated client-side from the fields already
  // held in state, so the only way to end up with an accurate list is to
  // ask the server again with the exact same filter that was just deleted.
  removeAll: async (status, scope) => {
    const previous = get().applications;
    // Optimistically empty the view immediately so the user gets an instant 0ms response
    if (!status) {
      set({ applications: [] });
    } else {
      set({ applications: previous.filter((a) => a.status !== status) });
    }

    try {
      await apiClient.delete('/api/candidatures', {
        params: { ...(status ? { status } : {}), ...(scope ? { scope } : {}) },
      });
      // Silent sync with server in background
      await get().fetchList(status, scope);
      toast.success('Candidatures supprimées');
    } catch (error: any) {
      set({ applications: previous });
      toast.error(error.response?.data?.message || 'Failed to delete applications');
      throw error;
    }
  },
  retryOne: async (id: string) => {
    try {
      await apiClient.post(`/api/candidatures/${id}/retry`);
      toast.success('Auto-apply relancé pour cette offre !');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Échec de la relance');
      throw error;
    }
  },
}));
