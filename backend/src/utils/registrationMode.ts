import {
  SECURITY_DEFAULTS,
  type RegistrationMode,
} from '../config/settings.schema';

export function normalizeRegistrationMode(value?: string | null): RegistrationMode {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'open' || normalized === 'approval' || normalized === 'closed'
    ? normalized
    : SECURITY_DEFAULTS.registrationMode;
}
