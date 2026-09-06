import type { ModelLabAPI } from '../shared/ipc';

declare global {
  interface Window { modelLab: ModelLabAPI }
}

export const api: ModelLabAPI = window.modelLab;
