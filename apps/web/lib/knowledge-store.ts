import { create } from 'zustand';
import apiClient from './api-client';
import { toast } from './toast-store';

export interface KnowledgeStatus {
  githubConfigured: boolean;
  githubUsername: string | null;
  itemCount: number;
  lastSyncedAt: string | null;
}

export interface KnowledgeItem {
  id: string;
  source: string;
  type: string;
  title: string;
  summary: string;
  skills: string[];
  url: string | null;
  metadata: Record<string, any> | null;
  syncedAt: string;
}

interface Store {
  status: KnowledgeStatus | null;
  items: KnowledgeItem[];
  loading: boolean;
  saving: boolean;
  syncing: boolean;
  fetchStatus: () => Promise<void>;
  fetchItems: () => Promise<void>;
  saveGithubToken: (token: string, username?: string) => Promise<void>;
  removeGithubToken: () => Promise<void>;
  sync: () => Promise<void>;
}

export const useKnowledgeStore = create<Store>((set, get) => ({
  status: null,
  items: [],
  loading: false,
  saving: false,
  syncing: false,

  fetchStatus: async () => {
    try {
      set({ loading: true });
      const response = await apiClient.get('/api/knowledge/status');
      set({ status: response.data, loading: false });
    } catch (error: any) {
      set({ loading: false });
      toast.error(error.response?.data?.message || 'Échec du chargement de la base de connaissance');
    }
  },

  fetchItems: async () => {
    try {
      set({ loading: true });
      const response = await apiClient.get('/api/knowledge');
      set({ items: response.data, loading: false });
    } catch (error: any) {
      set({ loading: false });
      toast.error(error.response?.data?.message || 'Échec du chargement des connaissances');
    }
  },

  saveGithubToken: async (token, username) => {
    try {
      set({ saving: true });
      const response = await apiClient.put('/api/knowledge/github-token', { token, username });
      set({ status: response.data, saving: false });
      toast.success('Token GitHub enregistré');
    } catch (error: any) {
      set({ saving: false });
      toast.error(error.response?.data?.message || 'Échec de l\'enregistrement du token');
    }
  },

  removeGithubToken: async () => {
    try {
      const response = await apiClient.delete('/api/knowledge/github-token');
      set({ status: response.data });
      toast.success('Token GitHub supprimé');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Échec de la suppression');
    }
  },

  sync: async () => {
    try {
      set({ syncing: true });
      const response = await apiClient.post('/api/knowledge/sync');
      const skippedNote = response.data.skipped ? ` (${response.data.skipped} écarté(s) : devoirs/doublons/vides)` : '';
      toast.success(`Synchronisation terminée : ${response.data.synced} dépôt(s)${skippedNote}`);
      set({ syncing: false });
      await Promise.all([get().fetchStatus(), get().fetchItems()]);
    } catch (error: any) {
      set({ syncing: false });
      toast.error(error.response?.data?.message || 'Échec de la synchronisation');
    }
  },
}));
