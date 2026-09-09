import { create } from 'zustand';
import apiClient from './api-client';
import { toast } from './toast-store';

export type SupportedPlatform = 'linkedin' | 'indeed' | 'france_travail' | 'hellowork';

export interface PlatformCredentialStatus {
  platform: SupportedPlatform;
  configured: boolean;
  email: string | null;
  lastLoginAt: string | null;
  lastLoginError: string | null;
}

interface Store {
  items: PlatformCredentialStatus[];
  loading: boolean;
  saving: boolean;
  fetchStatus: () => Promise<void>;
  save: (platform: SupportedPlatform, email: string, password: string) => Promise<void>;
  remove: (platform: SupportedPlatform) => Promise<void>;
}

export const usePlatformCredentialsStore = create<Store>((set) => ({
  items: [],
  loading: false,
  saving: false,

  fetchStatus: async () => {
    try {
      set({ loading: true });
      const response = await apiClient.get('/api/parametres/identifiants');
      set({ items: response.data, loading: false });
    } catch (error: any) {
      set({ loading: false });
      toast.error(error.response?.data?.message || 'Échec du chargement des identifiants');
    }
  },

  save: async (platform, email, password) => {
    try {
      set({ saving: true });
      const response = await apiClient.put('/api/parametres/identifiants', { platform, email, password });
      set({ items: response.data, saving: false });
      toast.success('Identifiants enregistrés');
    } catch (error: any) {
      set({ saving: false });
      toast.error(error.response?.data?.message || 'Échec de l\'enregistrement des identifiants');
    }
  },

  remove: async (platform) => {
    try {
      const response = await apiClient.delete(`/api/parametres/identifiants/${platform}`);
      set({ items: response.data });
      toast.success('Identifiants supprimés');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Échec de la suppression');
    }
  },
}));
