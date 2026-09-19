import { create } from 'zustand';
import apiClient from './api-client';
import { toast } from './toast-store';

export type SupportedPlatform = 'linkedin' | 'indeed' | 'france_travail' | 'hellowork' | 'welcome_to_the_jungle' | 'apec' | 'gmail';

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
  fetchStatus: () => Promise<void>;
  saveCredentials: (
    platform: SupportedPlatform,
    email: string,
    password?: string,
    sessionState?: string,
  ) => Promise<boolean>;
  remove: (platform: SupportedPlatform) => Promise<void>;
}

export const usePlatformCredentialsStore = create<Store>((set) => ({
  items: [],
  loading: false,

  fetchStatus: async () => {
    try {
      set({ loading: true });
      const response = await apiClient.get('/api/parametres/identifiants');
      set({ items: response.data, loading: false });
    } catch (error: any) {
      set({ loading: false });
      toast.error(error.response?.data?.message || 'Échec du chargement des sessions');
    }
  },

  saveCredentials: async (platform, email, password, sessionState) => {
    try {
      const response = await apiClient.post('/api/parametres/identifiants', {
        platform,
        email,
        password,
        sessionState,
      });
      set({ items: response.data });
      toast.success('Identifiants enregistrés');
      return true;
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Échec de l'enregistrement");
      return false;
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
