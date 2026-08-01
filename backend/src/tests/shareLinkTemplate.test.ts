import { shareLinkHtml, shareLinkText } from '../templates/shareLink';

describe('share-link email safety', () => {
  const params = {
    senderName: '<img src=x onerror=alert(1)>',
    senderEmail: 'sender@example.com',
    recipientEmail: 'recipient@example.com',
    appName: '<script>alert(1)</script>',
    shareUrl: 'https://apps.example/share/token?x=<unsafe>',
    isPasswordProtected: true,
    password: 'must-not-appear',
  };

  it('escapes user-controlled HTML and never puts the password beside the link', () => {
    const html = shareLinkHtml(params, { portalName: '<b>Portal</b>', accentColor: 'red' } as any);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('must-not-appear');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('separate channel');
  });

  it('keeps plaintext credentials out of the text alternative', () => {
    const text = shareLinkText(params);
    expect(text).not.toContain('must-not-appear');
    expect(text).toContain('separate channel');
  });
});
