import { create } from 'zustand';
import apiClient from './api-client';

export interface SettingsStatus {
  deepseekApiKey: boolean;
  franceTravailClientId: boolean;
  franceTravailClientSecret: boolean;
  adzunaAppId: boolean;
  adzunaApiKey: boolean;
}

interface Store {
  status: SettingsStatus | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  lastSavedAt: number | null;
  fetchStatus: () => Promise<void>;
  update: (fields: Partial<Record<keyof SettingsStatus, string>>) => Promise<void>;
}

export const useSettingsStore = create<Store>((set) => ({
  status: null,
  loading: false,
  saving: false,
  error: null,
  lastSavedAt: null,

  fetchStatus: async () => {
    try {
      set({ loading: true, error: null });
      const response = await apiClient.get('/api/parametres');
      set({ status: response.data, loading: false });
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to fetch settings', loading: false });
    }
  },

  update: async (fields) => {
    try {
      set({ saving: true, error: null });
      const response = await apiClient.put('/api/parametres', fields);
      set({ status: response.data, saving: false, lastSavedAt: Date.now() });
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to update settings', saving: false });
    }
  },
}));
