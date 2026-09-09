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
  fetchStatus: () => Promise<void>;
  remove: (platform: SupportedPlatform) => Promise<void>;
}

// Sessions are established out-of-band via `npm run establish-session --
// <platform> <email>` (see apps/api/scripts/establish-session.js) — there
// is no form here to submit credentials through, only status + revoke.
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

  remove: async (platform) => {
    try {
      const response = await apiClient.delete(`/api/parametres/identifiants/${platform}`);
      set({ items: response.data });
      toast.success('Session supprimée');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Échec de la suppression');
    }
  },
}));
