/* eslint-disable react-refresh/only-export-components */
/**
 * Add-on registry
 *
 * The single place where add-ons are switched on. Everything the rest of the
 * app needs is derived here, so `App.tsx` and `Settings.tsx` each only have to
 * reference a couple of stable names.
 *
 * To add an add-on: import it and append it to ADDONS.
 */

import { Fragment, type ReactNode } from 'react';
import { Route } from 'react-router-dom';
import type { SyncTransport } from '@fluxby/core';
import type { AddonSettingsTab, FluxbyAddon } from './types';
import { remoteSyncAddon } from './remote-sync';

export type { FluxbyAddon, AddonRoute, AddonSettingsTab } from './types';

/** Every enabled add-on, in display order. */
export const ADDONS: FluxbyAddon[] = [remoteSyncAddon];

/**
 * Composes every add-on's Provider around the app. Renders children untouched
 * when no add-on contributes a provider.
 */
export function AddonProviders({ children }: { children: ReactNode }) {
  return ADDONS.reduce<ReactNode>((tree, addon) => {
    const Provider = addon.Provider;
    return Provider ? <Provider key={addon.id}>{tree}</Provider> : tree;
  }, children) as React.ReactElement;
}

/** Routes contributed by add-ons, ready to drop into a <Routes> block. */
export const addonRoutes = (
  <Fragment>
    {ADDONS.flatMap((addon) =>
      (addon.routes ?? []).map((route) => (
        <Route
          key={`${addon.id}:${route.path}`}
          path={route.path}
          element={route.element}
        />
      ))
    )}
  </Fragment>
);

/** Settings tabs contributed by add-ons. */
export const addonSettingsTabs: AddonSettingsTab[] = ADDONS.flatMap(
  (addon) => addon.settingsTabs ?? []
);

/**
 * Sync transports contributed by add-ons.
 *
 * A module-level constant so the array identity stays stable across renders --
 * SyncProvider treats it as an effect dependency.
 */
export const addonSyncTransports: SyncTransport[] = ADDONS.flatMap(
  (addon) => addon.createSyncTransports?.() ?? []
);
