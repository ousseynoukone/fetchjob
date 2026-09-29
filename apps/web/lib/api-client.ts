import axios, { AxiosInstance } from 'axios';

// `||` would treat share-mac.command's intentional "" (same-origin, see
// next.config.js rewrites) as unset and silently fall back to localhost —
// this only falls back when the var is truly absent.
const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL;
const apiClient: AxiosInstance = axios.create({
  baseURL: configuredApiUrl === undefined ? 'http://localhost:4000' : configuredApiUrl,
  headers: {
    'Content-Type': 'application/json',
  },
});

export default apiClient;
