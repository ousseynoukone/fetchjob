import { create } from 'zustand';
import apiClient from './api-client';
import { toast } from './toast-store';

export interface Campaign {
  id: string;
  status: 'active' | 'paused' | 'running' | 'completed';
  jobTitle: string;
  location: string;
  remote: boolean;
  contractTypes: string[];
  keywords: string[];
  excludeKeywords: string[];
  maxAgeMonths: number;
  maxApplicationsPerDay: number;
  minMatchScore: number;
  actionMode: 'prepare_only' | 'auto_apply';
  sources: string[];
  totalOffersScanned: number;
  totalOffersFiltered: number;
  totalApplicationsPrepared: number;
  totalApplicationsSent: number;
  lastRunAt?: string;
}

export interface CampaignRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  offersScanned: number;
  offersFiltered: number;
  applicationsPrepared: number;
  applicationsSent: number;
  error?: string;
  logs: string[];
}

interface Store {
  campaign: Campaign | null;
  latestRun: CampaignRun | null;
  loading: boolean;
  saving: boolean;
  running: boolean;
  error: string | null;
  fetchCampaign: () => Promise<void>;
  updateCampaign: (data: Partial<Campaign>) => Promise<void>;
  runCampaign: () => Promise<void>;
  pauseCampaign: () => Promise<void>;
  fetchLatestRun: () => Promise<void>;
}

export const useCampaignStore = create<Store>((set, get) => ({
  campaign: null,
  latestRun: null,
  loading: false,
  saving: false,
  running: false,
  error: null,

  fetchCampaign: async () => {
    try {
      set({ loading: true, error: null });
      const response = await apiClient.get('/api/campagne');
      set({ campaign: response.data, loading: false, running: response.data.status === 'running' });
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to fetch campaign', loading: false });
    }
  },

  updateCampaign: async (data) => {
    try {
      set({ saving: true, error: null });
      const response = await apiClient.put('/api/campagne', data);
      set({ campaign: response.data, saving: false });
      toast.success('Campagne enregistrée');
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to update campaign';
      set({ error: message, saving: false });
      toast.error(message);
    }
  },

  runCampaign: async () => {
    try {
      set({ running: true, error: null });
      const response = await apiClient.post('/api/campagne/run');
      set({ latestRun: response.data });
      await get().fetchCampaign();
      toast.success('Campagne lancée');
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to start campaign';
      set({ error: message, running: false });
      toast.error(message);
    }
  },

  pauseCampaign: async () => {
    try {
      const response = await apiClient.post('/api/campagne/pause');
      set({ campaign: response.data, running: false });
      toast.info('Campagne mise en pause');
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to pause campaign';
      set({ error: message });
      toast.error(message);
    }
  },

  fetchLatestRun: async () => {
    try {
      const response = await apiClient.get('/api/campagne/logs');
      set({ latestRun: response.data });
      if (response.data?.finishedAt) {
        set({ running: false });
      }
    } catch {
      // ignore polling failures
    }
  },
}));
