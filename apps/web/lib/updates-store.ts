import { create } from 'zustand';
import apiClient from './api-client';
import { toast } from './toast-store';
import type { Application } from './applications-store';

interface Store {
  unseenCount: number;
  updates: Application[];
  loading: boolean;
  pollHandle: ReturnType<typeof setInterval> | null;
  fetchCount: () => Promise<void>;
  fetchList: () => Promise<void>;
  markSeen: (id: string) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

// Lightweight count polled from every page via AppShell (see
// startPolling/stopPolling below) — the badge needs to be visible app-wide,
// not just on one page, so this follows the same setInterval fallback shape
// campaign-page.tsx uses rather than an app-wide SSE connection.
const POLL_INTERVAL_MS = 45_000;

export const useUpdatesStore = create<Store>((set, get) => ({
  unseenCount: 0,
  updates: [],
  loading: false,
  pollHandle: null,

  fetchCount: async () => {
    try {
      const res = await apiClient.get('/api/candidatures/updates/count');
      set({ unseenCount: res.data.count });
    } catch {
      // Silent — a failed badge poll shouldn't interrupt the rest of the app.
    }
  },

  fetchList: async () => {
    set({ loading: true });
    try {
      const res = await apiClient.get('/api/candidatures/updates');
      set({ updates: res.data, unseenCount: res.data.length });
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Impossible de charger les mises à jour.');
    } finally {
      set({ loading: false });
    }
  },

  markSeen: async (id: string) => {
    try {
      await apiClient.post(`/api/candidatures/${id}/updates/seen`);
      set((s) => ({
        updates: s.updates.filter((u) => u.id !== id),
        unseenCount: Math.max(0, s.unseenCount - 1),
      }));
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Impossible de marquer cette mise à jour comme vue.');
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
