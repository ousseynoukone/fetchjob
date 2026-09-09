import { create } from 'zustand';
import apiClient from './api-client';
import { toast } from './toast-store';

export interface VerificationRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  checked: number;
  confirmed: number;
  unconfirmed: number;
  error?: string;
  logs: string[];
}

interface Store {
  latestRun: VerificationRun | null;
  history: VerificationRun[];
  running: boolean;
  fetchLatestRun: () => Promise<void>;
  fetchHistory: () => Promise<void>;
  runVerification: () => Promise<void>;
  connectStream: () => () => void;
}

export const useVerificationStore = create<Store>((set, get) => ({
  latestRun: null,
  history: [],
  running: false,

  fetchLatestRun: async () => {
    try {
      const response = await apiClient.get('/api/verification/latest');
      set({ latestRun: response.data, running: !!response.data && !response.data.finishedAt });
    } catch {
      // ignore
    }
  },

  fetchHistory: async () => {
    try {
      const response = await apiClient.get('/api/verification/runs');
      set({ history: response.data });
    } catch {
      // ignore
    }
  },

  runVerification: async () => {
    try {
      set({ running: true });
      const response = await apiClient.post('/api/verification/run');
      set({ latestRun: response.data });
      toast.success('Vérification lancée');
    } catch (error: any) {
      set({ running: false });
      toast.error(error.response?.data?.message || 'Échec du lancement de la vérification');
    }
  },

  // Same live-log pattern as the campaign page's SSE stream.
  connectStream: () => {
    const source = new EventSource(`${apiClient.defaults.baseURL}/api/verification/stream`);

    source.onmessage = (event) => {
      let payload: { runId: string; type: 'log' | 'done'; message: string; at: string };
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      const current = get().latestRun;
      if (current && current.id && current.id !== payload.runId) return;

      if (payload.type === 'done') {
        set({ running: false });
        get().fetchLatestRun();
        get().fetchHistory();
        return;
      }

      if (current) {
        set({ latestRun: { ...current, logs: [...(current.logs || []), payload.message] } });
      } else {
        get().fetchLatestRun();
      }
    };

    source.onerror = () => {};

    return () => source.close();
  },
}));
