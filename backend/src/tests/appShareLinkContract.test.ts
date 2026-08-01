import fs from 'fs';
import path from 'path';

/**
 * App share links are public by default — the Apps library only offers expiry
 * and use limits. But the route used to drop `isPublic` and `password` on the
 * floor if a caller sent them, handing back a public link while the caller
 * believed it was protected. Every read path in the file gates on
 * `!isPublic && passwordHash`, so both must actually be persisted.
 */
describe('app share link creation contract', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../routes/apps.ts'), 'utf8');
  const createRoute = (() => {
    const start = source.indexOf("router.post('/:id/share'");
    const end = source.indexOf("router.get('/:id/share'", start);
    return source.slice(start, end);
  })();

  test('persists isPublic and passwordHash rather than dropping them', () => {
    expect(createRoute).toContain('isPublic,');
    expect(createRoute).toContain('passwordHash,');
  });

  test('a private link must carry a validated, hashed password', () => {
    expect(createRoute).toContain("res.status(400).json({ error: 'Password required for password-protected links' })");
    expect(createRoute).toContain('validateSharePassword(password)');
    expect(createRoute).toContain('bcrypt.hash(password, 12)');
  });

  test('refuses the contradiction instead of silently downgrading', () => {
    // A password on a public link protects nothing; saying so beats ignoring it.
    expect(createRoute).toContain('SHARE_PASSWORD_REQUIRES_PRIVATE_LINK');
  });

  test('stays public by default so existing share flows are unchanged', () => {
    expect(createRoute).toContain('requestedPublic === undefined ? true');
  });

  test('never returns the hash to the client', () => {
    expect(createRoute).toContain('redactShareLink(shareLink)');
  });
});
