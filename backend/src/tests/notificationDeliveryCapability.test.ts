const sendEmail = jest.fn();
const sendSystemAlert = jest.fn();
const systemSettingFindUnique = jest.fn();
const getCachedBranding = jest.fn();

jest.mock('../services/mailService', () => ({
  sendEmail,
  sendSystemAlert,
}));

jest.mock('../config/database', () => ({
  prisma: {
    systemSetting: { findUnique: systemSettingFindUnique },
  },
}));

jest.mock('../templates/baseTemplate', () => ({
  getCachedBranding,
}));

jest.mock('../templates/welcome', () => ({
  welcomeHtml: jest.fn(() => '<p>Welcome</p>'),
  welcomeText: jest.fn(() => 'Welcome'),
}));

jest.mock('../templates/passwordChanged', () => ({
  passwordChangedHtml: jest.fn(() => '<p>Password changed</p>'),
  passwordChangedText: jest.fn(() => 'Password changed'),
}));

jest.mock('../templates/twoFactorCode', () => ({
  twoFactorCodeHtml: jest.fn(() => '<p>123456</p>'),
  twoFactorCodeText: jest.fn(() => '123456'),
}));

import {
  sendPasswordChangedEmail,
  sendTwoFactorCodeEmail,
  sendWelcomeEmail,
} from '../services/notificationService';
import { PortalFeatureUnavailableError } from '../utils/portalFeatureCapabilities';

describe('notification delivery capability truth', () => {
  const originalOriginMode = process.env.ORIGIN_MODE;
  const originalInstallProfile = process.env.INSTALL_PROFILE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = 'server';
    systemSettingFindUnique.mockResolvedValue({ value: 'true' });
    getCachedBranding.mockResolvedValue({
      portalName: 'Example Portal',
      logoUrl: null,
      accentColor: '#2563eb',
      portalUrl: 'https://portal.example.test',
    });
    sendEmail.mockResolvedValue({ success: true, messageId: 'message-1' });
    sendSystemAlert.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalOriginMode === undefined) delete process.env.ORIGIN_MODE;
    else process.env.ORIGIN_MODE = originalOriginMode;
    if (originalInstallProfile === undefined) delete process.env.INSTALL_PROFILE;
    else process.env.INSTALL_PROFILE = originalInstallProfile;
  });

  test('optional notifications skip before settings, branding, or delivery in Tailnet mode', async () => {
    process.env.ORIGIN_MODE = 'tailnet';

    await sendWelcomeEmail({ email: 'owner@example.test', username: 'owner' });
    await sendPasswordChangedEmail({ email: 'owner@example.test', username: 'owner' });

    expect(systemSettingFindUnique).not.toHaveBeenCalled();
    expect(getCachedBranding).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('critical two-factor delivery propagates a typed unavailable-mail failure', async () => {
    process.env.ORIGIN_MODE = 'tailnet';

    await expect(sendTwoFactorCodeEmail(
      { email: 'owner@example.test' },
      '123456',
    )).rejects.toBeInstanceOf(PortalFeatureUnavailableError);

    expect(getCachedBranding).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('domain mode still dispatches optional notifications', async () => {
    await sendWelcomeEmail({ email: 'owner@example.test', username: 'owner' });

    expect(getCachedBranding).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
