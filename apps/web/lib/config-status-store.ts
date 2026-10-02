import { create } from 'zustand';
import apiClient from './api-client';

interface Store {
  missingConfigCount: number;
  pollHandle: ReturnType<typeof setInterval> | null;
  fetchCount: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

// Same polling shape as updates-store.ts's unseen-count badge.
const POLL_INTERVAL_MS = 45_000;

export const useConfigStatusStore = create<Store>((set, get) => ({
  missingConfigCount: 0,
  pollHandle: null,

  fetchCount: async () => {
    try {
      const res = await apiClient.get('/api/parametres/missing-config-count');
      set({ missingConfigCount: res.data.count });
    } catch {
      // Silent — a failed badge poll shouldn't interrupt the rest of the app.
    }
  },

  startPolling: () => {
    if (get().pollHandle) return;
    get().fetchCount();
    const handle = setInterval(() => get().fetchCount(), POLL_INTERVAL_MS);
    set({ pollHandle: handle });
  },

  stopPolling: () => {
    const handle = get().pollHandle;
    if (handle) clearInterval(handle);
    set({ pollHandle: null });
  },
}));
