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
  seniorityKeywords: string[];
  maxAgeMonths: number;
  maxApplicationsPerDay: number;
  minMatchScore: number;
  actionMode: 'prepare_only' | 'auto_apply';
  sources: string[];
  sourceDailyLimits: Record<string, number>;
  scheduleEnabled: boolean;
  scheduleHour: number | null;
  autoApplyAts: boolean;
  autoApplyMinDelaySeconds: number;
  autoApplyMaxDelaySeconds: number;
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
  liveFrame: string | null;
  liveFrameApplicationId: string | null;
  fetchCampaign: () => Promise<void>;
  updateCampaign: (data: Partial<Campaign>) => Promise<void>;
  runCampaign: () => Promise<void>;
  pauseCampaign: () => Promise<void>;
  fetchLatestRun: () => Promise<void>;
  connectStream: () => () => void;
  connectLiveView: () => () => void;
}

export const useCampaignStore = create<Store>((set, get) => ({
  campaign: null,
  latestRun: null,
  loading: false,
  saving: false,
  running: false,
  error: null,
  liveFrame: null,
  liveFrameApplicationId: null,

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

  // Live feed of the current run's log lines, pushed the moment each
  // candidature is scanned/prepared/sent — replaces re-polling /campagne/logs
  // on a timer. Returns a cleanup function so the caller's effect can close
  // the connection on unmount.
  connectStream: () => {
    const source = new EventSource(`${apiClient.defaults.baseURL}/api/campagne/stream`);

    source.onmessage = (event) => {
      let payload: { runId: string; type: 'log' | 'done'; message: string; at: string };
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      const current = get().latestRun;
      // Ignore lines from a run other than the one currently displayed (e.g.
      // a stale event delivered right as a brand-new run just started).
      if (current && current.id && current.id !== payload.runId) return;

      if (payload.type === 'done') {
        set({ running: false });
        get().fetchLatestRun();
        return;
      }

      if (current) {
        set({ latestRun: { ...current, logs: [...(current.logs || []), payload.message] } });
      } else {
        get().fetchLatestRun();
      }
    };

    // The browser auto-reconnects a dropped EventSource on its own; nothing
    // to do here beyond not crashing the tab over a transient network blip.
    source.onerror = () => {};

    return () => source.close();
  },

  // Live view of the browser during an auto-apply attempt — a stream of
  // screenshots (data URLs), not a video file: each one just replaces the
  // last as it arrives. Stays quiet (liveFrame never updates) whenever no
  // candidature is actively being applied to.
  connectLiveView: () => {
    const source = new EventSource(`${apiClient.defaults.baseURL}/api/campagne/live-view`);

    source.onmessage = (event) => {
      let payload: { applicationId: string; dataUrl: string };
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      set({ liveFrame: payload.dataUrl, liveFrameApplicationId: payload.applicationId });
    };

    source.onerror = () => {};

    return () => source.close();
  },
}));
