import {
  APP_API_TARGET_PREFIX,
  appApiBindingKey,
  appApiTargetEnvironmentKey,
  configuredAppApiTargetBinding,
} from '../utils/appApiProxyAuth';

export interface AppApiTargetAuditApp {
  id: string;
  name: string;
}

export type AppApiTargetBindingBlocker = Readonly<
  | {
    kind: 'missing-id-binding';
    appId: string;
    obsoleteNameKey: string;
    requiredIdKey: string;
  }
  | {
    kind: 'invalid-id-binding';
    appId: string;
    requiredIdKey: string;
  }
>;

export interface ObsoleteAppApiTargetBindingWarning {
  kind: 'obsolete-name-binding';
  appId: string;
  obsoleteNameKey: string;
  requiredIdKey: string;
}

export interface AppApiTargetBindingAuditResult {
  checkedApps: number;
  blockers: AppApiTargetBindingBlocker[];
  warnings: ObsoleteAppApiTargetBindingWarning[];
}

function hasOwnEnvironmentKey(environment: NodeJS.ProcessEnv, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(environment, key)
    && environment[key] !== undefined;
}

/**
 * Inspect only explicit environment keys and immutable App ids.
 *
 * A missing per-id binding is actionable only when the operator already
 * supplied the exact legacy name-derived key for that same current App. An
 * absent binding by itself is valid because most Apps use a Portal-managed
 * runtime. This audit never derives a target value from an App name, path, or
 * port and never mutates the environment.
 */
export function auditAppApiTargetBindings(
  apps: readonly AppApiTargetAuditApp[],
  environment: NodeJS.ProcessEnv = process.env,
): AppApiTargetBindingAuditResult {
  const normalizedApps = [...apps]
    .map((app) => ({ id: String(app.id || '').trim(), name: String(app.name || '').trim() }))
    .filter((app) => app.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
  const validIdKeys = new Set(
    normalizedApps
      .map((app) => appApiTargetEnvironmentKey(app.id))
      .filter((key): key is string => Boolean(key)),
  );
  const blockers: AppApiTargetBindingBlocker[] = [];
  const warnings: ObsoleteAppApiTargetBindingWarning[] = [];

  for (const app of normalizedApps) {
    const requiredIdKey = appApiTargetEnvironmentKey(app.id);
    if (!requiredIdKey) continue;

    if (
      hasOwnEnvironmentKey(environment, requiredIdKey)
      && configuredAppApiTargetBinding(app.id, environment).status === 'invalid'
    ) {
      blockers.push({
        kind: 'invalid-id-binding',
        appId: app.id,
        requiredIdKey,
      });
    }

    const normalizedName = appApiBindingKey(app.name);
    if (!normalizedName) continue;
    const obsoleteNameKey = `${APP_API_TARGET_PREFIX}${normalizedName}`;

    // A name-derived token can coincide with another App's immutable id
    // token. That key is authoritative for the other App and is not evidence
    // of a legacy binding, so do not infer ownership from the name collision.
    if (obsoleteNameKey === requiredIdKey || validIdKeys.has(obsoleteNameKey)) continue;
    if (!hasOwnEnvironmentKey(environment, obsoleteNameKey)) continue;

    if (!hasOwnEnvironmentKey(environment, requiredIdKey)) {
      blockers.push({
        kind: 'missing-id-binding',
        appId: app.id,
        obsoleteNameKey,
        requiredIdKey,
      });
      continue;
    }
    warnings.push({
      kind: 'obsolete-name-binding',
      appId: app.id,
      obsoleteNameKey,
      requiredIdKey,
    });
  }

  return { checkedApps: normalizedApps.length, blockers, warnings };
}
