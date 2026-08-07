/**
 * Fluxby Add-on types
 *
 * An add-on is an optional, self-contained feature that plugs into the app
 * through a small set of extension points. Add-ons live entirely under
 * `apps/web/src/addons/`, so pulling changes from upstream Fluxby only ever
 * touches the handful of one-line seams in `App.tsx` and `Settings.tsx`.
 */

import type { ComponentType, ReactNode } from 'react';
import type { SyncTransport } from '@fluxby/core';

/** A route mounted inside the main app Layout. */
export interface AddonRoute {
  /** Path relative to the app root, e.g. 'remote-sync' */
  path: string;
  element: ReactNode;
}

/** A tab added to the Settings page. */
export interface AddonSettingsTab {
  /** Stable id, used as the `?tab=` query value */
  id: string;
  /** Tab label. A plain string; add-ons own their own translations. */
  label: string;
  element: ReactNode;
}

export interface FluxbyAddon {
  /** Stable identifier, unique across add-ons */
  id: string;
  /** Human-readable name */
  name: string;
  description?: string;

  /**
   * Context provider wrapped around the whole app. Use for add-on state that
   * has to outlive route changes.
   */
  Provider?: ComponentType<{ children: ReactNode }>;

  /** Extra routes mounted under the main Layout */
  routes?: AddonRoute[];

  /** Extra tabs on the Settings page */
  settingsTabs?: AddonSettingsTab[];

  /**
   * Sync transports contributed by this add-on. Called once at startup.
   * Construction must be cheap and must not open connections -- the registry
   * calls `initialize()` for that.
   */
  createSyncTransports?: () => SyncTransport[];
}
