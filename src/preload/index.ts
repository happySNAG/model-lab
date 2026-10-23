// Cernum · preload bridge. Exposes a typed, narrow API to the renderer; nothing else crosses.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, CernumAPI, SessionProgress, PullProgress, OllamaStatus, ScreenID, CampaignProgressEvent } from '../shared/ipc';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: CernumAPI = {
  getBuildInfo: () => ipcRenderer.invoke(IPC.buildInfo),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.saveSettings, settings),
  getMachine: (refresh) => ipcRenderer.invoke(IPC.getMachine, refresh),
  getOllamaStatus: () => ipcRenderer.invoke(IPC.ollamaStatus),
  startOllama: () => ipcRenderer.invoke(IPC.startOllama),
  openOllamaDownload: () => ipcRenderer.invoke(IPC.openOllamaDownload),
  listModels: () => ipcRenderer.invoke(IPC.listModels),
  pullModel: (model) => ipcRenderer.invoke(IPC.pullModel, model),
  cancelPull: () => ipcRenderer.invoke(IPC.cancelPull),
  listSuites: () => ipcRenderer.invoke(IPC.listSuites),
  preflight: (configuration) => ipcRenderer.invoke(IPC.preflight, configuration),
  startBenchmark: (configuration) => ipcRenderer.invoke(IPC.startBenchmark, configuration),
  cancelBenchmark: () => ipcRenderer.invoke(IPC.cancelBenchmark),
  getActiveProgress: () => ipcRenderer.invoke(IPC.activeProgress),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getSessionResults: (sessionID) => ipcRenderer.invoke(IPC.sessionResults, sessionID),
  getAttemptDetail: (attemptID) => ipcRenderer.invoke(IPC.attemptDetail, attemptID),
  recordRecommendation: (sessionID, candidateID) => ipcRenderer.invoke(IPC.recordRecommendation, sessionID, candidateID),
  getHistory: () => ipcRenderer.invoke(IPC.history),
  compareSessions: (a, b) => ipcRenderer.invoke(IPC.compareSessions, a, b),
  getDiagnostics: () => ipcRenderer.invoke(IPC.diagnostics),
  exportEvidence: () => ipcRenderer.invoke(IPC.exportEvidence),
  openPath: (target) => ipcRenderer.invoke(IPC.openPath, target),
  revealPath: (target) => ipcRenderer.invoke(IPC.revealPath, target),
  copyDiagnostics: () => ipcRenderer.invoke(IPC.copyDiagnostics),
  onProgress: (listener) => subscribe<SessionProgress>(IPC.eventProgress, listener),
  onPullProgress: (listener) => subscribe<PullProgress>(IPC.eventPull, listener),
  onOllamaStatus: (listener) => subscribe<OllamaStatus>(IPC.eventOllama, listener),
  onNavigate: (listener) => subscribe<ScreenID>(IPC.eventNavigate, listener),
  listCampaigns: () => ipcRenderer.invoke(IPC.listCampaigns),
  campaignDetail: (name) => ipcRenderer.invoke(IPC.campaignDetail, name),
  campaignSuites: () => ipcRenderer.invoke(IPC.campaignSuites),
  createCampaign: (request) => ipcRenderer.invoke(IPC.createCampaign, request),
  startCampaign: (name) => ipcRenderer.invoke(IPC.startCampaign, name),
  pauseCampaign: () => ipcRenderer.invoke(IPC.pauseCampaign),
  verifyCampaign: (name) => ipcRenderer.invoke(IPC.verifyCampaign, name),
  finalizeCampaign: (name) => ipcRenderer.invoke(IPC.finalizeCampaign, name),
  campaignRoot: () => ipcRenderer.invoke(IPC.campaignRoot),
  campaignDisclosure: (name) => ipcRenderer.invoke(IPC.campaignDisclosure, name),
  leasedEndpoints: () => ipcRenderer.invoke(IPC.leasedEndpoints),
  providerStatuses: () => ipcRenderer.invoke(IPC.providerStatuses),
  requestedCohort: () => ipcRenderer.invoke(IPC.requestedCohort),
  discoverProvider: (provider) => ipcRenderer.invoke(IPC.discoverProvider, provider),
  previewCampaignCost: (request) => ipcRenderer.invoke(IPC.previewCampaignCost, request),
  campaignCost: (name) => ipcRenderer.invoke(IPC.campaignCost, name),
  authorizeCampaign: (name, ceilingMicroUSD) => ipcRenderer.invoke(IPC.authorizeCampaign, name, ceilingMicroUSD),
  terminalCommand: () => ipcRenderer.invoke(IPC.terminalCommand),
  installTerminalCommand: () => ipcRenderer.invoke(IPC.installTerminalCommand),
  uninstallTerminalCommand: () => ipcRenderer.invoke(IPC.uninstallTerminalCommand),
  onCampaignProgress: (listener) => subscribe<CampaignProgressEvent>(IPC.eventCampaign, listener),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('cernum', api);
