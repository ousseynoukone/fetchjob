import { create } from 'zustand';
import apiClient from './api-client';
import { toast } from './toast-store';

interface CV {
  fullName: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  summary?: string;
  photo?: string;
  links: Array<{
    type: string;
    url: string;
    label?: string;
  }>;
  skillGroups: Array<{
    label: string;
    items: string[];
  }>;
  experiences: Array<{
    role: string;
    company: string;
    location: string;
    period: string;
    bullets: string[];
    appUrl?: string;
  }>;
  projects: Array<{
    name: string;
    period?: string;
    url?: string;
    bullets: string[];
  }>;
  education: Array<{
    degree: string;
    school: string;
    location?: string;
    period: string;
    precision?: string;
    link?: string;
  }>;
  certifications: Array<{
    name: string;
    issuer: string;
    date: string;
    url?: string;
  }>;
  languages: Array<{
    name: string;
    level: string;
  }>;
  interests?: string[];
  githubUsername?: string;
  additionalContext?: string;
  options: {
    fontSize: number;
    compact: boolean;
    template: string;
    accent?: string;
  };
}

interface Store {
  cv: CV | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  lastSavedAt: number | null;
  fetchCV: () => Promise<void>;
  updateCV: (cv: Partial<CV>) => Promise<void>;
  setCV: (cv: CV) => void;
  reset: () => void;
}

export const useCVStore = create<Store>((set) => ({
  cv: null,
  loading: false,
  saving: false,
  error: null,
  lastSavedAt: null,

  fetchCV: async () => {
    try {
      set({ loading: true, error: null });
      const response = await apiClient.get('/api/cv');
      set({ cv: response.data, loading: false });
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to fetch CV', loading: false });
    }
  },

  updateCV: async (cvUpdate) => {
    try {
      set({ saving: true, error: null });
      const response = await apiClient.put('/api/cv', cvUpdate);
      set({ cv: response.data, saving: false, lastSavedAt: Date.now() });
      toast.success('CV enregistré');
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to update CV';
      set({ error: message, saving: false });
      toast.error(message);
    }
  },

  setCV: (cv) => set({ cv }),

  reset: () => set({ cv: null, loading: false, saving: false, error: null, lastSavedAt: null }),
}));
