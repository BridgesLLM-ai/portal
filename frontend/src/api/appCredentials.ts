import client from './client';

// Named App credentials (Portal Owner only). Values are
// write-only: no response carries a value, its ciphertext or its size.

export interface AppCredentialSlotView {
  slot: string;
  revision: number;
  updatedAt: string;
  updatedBy: { kind: 'operator' } | { kind: 'user'; username: string | null };
}

export interface AppCredentialsView {
  app: { id: string; name: string };
  revision: number;
  slots: AppCredentialSlotView[];
  limits: { maxSlots: number; maxBytes: number };
  containerDirectory: string;
  runtime: { running: boolean; restartRequired: boolean };
}

// A write that timed out may already have been stored; never resend it blindly.
const NO_AUTO_RETRY = { _skipNetworkRetry: true } as Record<string, unknown>;
const base = (appId: string) => `/app-credentials/${encodeURIComponent(appId)}`;

export const appCredentialsAPI = {
  list: async (appId: string): Promise<AppCredentialsView> => (await client.get(base(appId))).data,
  /** expectedRevision null adds a new credential; a number replaces exactly that revision. */
  set: async (appId: string, slot: string, value: string, expectedRevision: number | null): Promise<AppCredentialsView> =>
    (await client.put(`${base(appId)}/${encodeURIComponent(slot)}`, { value, expectedRevision }, NO_AUTO_RETRY)).data,
  remove: async (appId: string, slot: string, expectedRevision: number): Promise<AppCredentialsView> =>
    (await client.delete(`${base(appId)}/${encodeURIComponent(slot)}`, { params: { expectedRevision }, ...NO_AUTO_RETRY })).data,
};
