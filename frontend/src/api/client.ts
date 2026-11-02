import axios from 'axios';

// Relative by default so requests go to the same origin as the page and are
// proxied to the backend (Vite in dev, nginx in Docker).
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
});

export default api;
