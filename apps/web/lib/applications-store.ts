import { create } from 'zustand';
import apiClient from './api-client';

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
  appliedAt?: string;
  createdAt: string;
  jobOffer: JobOffer;
}

interface Store {
  applications: Application[];
  current: Application | null;
  loading: boolean;
  error: string | null;
  fetchList: (status?: string) => Promise<void>;
  fetchById: (id: string) => Promise<void>;
  updateStatus: (id: string, status: string) => Promise<void>;
  markApplied: (id: string) => Promise<void>;
  regenerate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeAll: (status?: string) => Promise<void>;
}

export const useApplicationsStore = create<Store>((set, get) => ({
  applications: [],
  current: null,
  loading: false,
  error: null,

  fetchList: async (status) => {
    try {
      set({ loading: true, error: null });
      const response = await apiClient.get('/api/candidatures', { params: status ? { status } : {} });
      set({ applications: response.data, loading: false });
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to fetch applications', loading: false });
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
    const response = await apiClient.patch(`/api/candidatures/${id}/status`, { status });
    set({ current: response.data });
    set({ applications: get().applications.map((a) => (a.id === id ? { ...a, status } : a)) });
  },

  markApplied: async (id) => {
    const response = await apiClient.post(`/api/candidatures/${id}/apply`);
    set({ current: response.data });
    set({
      applications: get().applications.map((a) =>
        a.id === id ? { ...a, status: 'applied', appliedAt: response.data.appliedAt } : a,
      ),
    });
  },

  regenerate: async (id) => {
    try {
      set({ loading: true, error: null });
      const response = await apiClient.post(`/api/candidatures/${id}/regen`);
      set({ current: response.data, loading: false });
    } catch (error: any) {
      set({
        error: error.response?.data?.message || 'La génération IA a échoué.',
        loading: false,
      });
      throw error;
    }
  },

  remove: async (id) => {
    await apiClient.delete(`/api/candidatures/${id}`);
    set({ applications: get().applications.filter((a) => a.id !== id) });
  },

  removeAll: async (status) => {
    await apiClient.delete('/api/candidatures', { params: status ? { status } : {} });
    set({
      applications: status ? get().applications.filter((a) => a.status !== status) : [],
    });
  },
}));
