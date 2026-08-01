const sendMail = jest.fn();
const createTransport = jest.fn(() => ({ sendMail }));
const findMany = jest.fn();

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport },
}));

jest.mock('../config/database', () => ({
  prisma: {
    systemSetting: { findMany },
    user: { findMany: jest.fn() },
  },
}));

import { sendEmail } from '../services/email';
import { PortalFeatureUnavailableError } from '../utils/portalFeatureCapabilities';

describe('email service', () => {
  const originalOriginMode = process.env.ORIGIN_MODE;
  const originalInstallProfile = process.env.INSTALL_PROFILE;

  beforeEach(() => {
    createTransport.mockClear();
    sendMail.mockReset().mockResolvedValue({ messageId: 'test' });
    findMany.mockReset().mockResolvedValue([
      { key: 'smtp.host', value: 'smtp.example.test' },
      { key: 'smtp.port', value: '587' },
      { key: 'smtp.secure', value: 'false' },
      { key: 'smtp.user', value: 'portal@example.test' },
      { key: 'smtp.password', value: 'secret' },
      { key: 'smtp.fromName', value: 'Portal' },
      { key: 'smtp.fromEmail', value: 'portal@example.test' },
    ]);
    delete process.env.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = 'server';
  });

  afterAll(() => {
    if (originalOriginMode === undefined) delete process.env.ORIGIN_MODE;
    else process.env.ORIGIN_MODE = originalOriginMode;
    if (originalInstallProfile === undefined) delete process.env.INSTALL_PROFILE;
    else process.env.INSTALL_PROFILE = originalInstallProfile;
  });

  test('sends through Nodemailer 9 with external file and URL access disabled', async () => {
    await sendEmail({
      to: 'owner@example.test',
      subject: 'Test',
      text: 'Safe body',
    });

    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      auth: { user: 'portal@example.test', pass: 'secret' },
    });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'owner@example.test',
      subject: 'Test',
      disableFileAccess: true,
      disableUrlAccess: true,
    }));
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty('raw');
  });

  test('fails closed when SMTP is incomplete', async () => {
    findMany.mockResolvedValue([{ key: 'smtp.host', value: 'smtp.example.test' }]);
    await expect(sendEmail({ to: 'owner@example.test', subject: 'Test', text: 'Body' }))
      .rejects.toThrow('SMTP is not fully configured');
    expect(createTransport).not.toHaveBeenCalled();
  });

  test.each([
    { ORIGIN_MODE: 'tailnet', INSTALL_PROFILE: 'server' },
    { ORIGIN_MODE: '', INSTALL_PROFILE: 'local' },
  ])('rejects before loading persisted SMTP credentials when mail is unavailable ($ORIGIN_MODE/$INSTALL_PROFILE)', async (environment) => {
    process.env.ORIGIN_MODE = environment.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = environment.INSTALL_PROFILE;

    await expect(sendEmail({
      to: 'owner@example.test',
      subject: 'Must not send',
      text: 'Body',
    })).rejects.toBeInstanceOf(PortalFeatureUnavailableError);

    expect(findMany).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
