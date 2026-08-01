import { createContext, useContext, type ReactNode } from 'react';

export type SettingsMutationClaim = (owner: string) => boolean;
export type SettingsMutationRelease = (owner: string) => void;

export type SettingsMutationCoordinator = {
  owner: string | null;
  claim: SettingsMutationClaim;
  release: SettingsMutationRelease;
};

const SettingsMutationContext = createContext<SettingsMutationCoordinator | null>(null);

export function SettingsMutationProvider({
  value,
  children,
}: {
  value: SettingsMutationCoordinator;
  children: ReactNode;
}) {
  return (
    <SettingsMutationContext.Provider value={value}>
      {children}
    </SettingsMutationContext.Provider>
  );
}

/**
 * Settings descendants use this optional coordinator for server mutations.
 * The same components are mounted by Setup and Agent Chat, where no Settings
 * coordinator exists and their local admission guards remain authoritative.
 */
export function useSettingsMutationCoordinator(): SettingsMutationCoordinator | null {
  return useContext(SettingsMutationContext);
}
