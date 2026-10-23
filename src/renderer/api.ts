import type { CernumAPI } from '../shared/ipc';

declare global {
  interface Window { cernum: CernumAPI }
}

export const api: CernumAPI = window.cernum;
