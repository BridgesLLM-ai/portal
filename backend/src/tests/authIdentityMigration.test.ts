import fs from 'fs';
import path from 'path';

describe('Portal 4.0 auth identity migration', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../../prisma/migrations/20260718_auth_identity_transactions/migration.sql'),
    'utf8',
  );

  test('fails closed on canonical identity and pending-registration collisions', () => {
    expect(sql).toContain('case/whitespace-insensitive collisions exist');
    expect(sql).toMatch(/GROUP BY lower\(btrim\("email"\)\)/);
    expect(sql).toMatch(/GROUP BY lower\(btrim\("username"\)\)/);
    expect(sql).toContain('blank email or username exists');
    expect(sql).toMatch(/CHECK \("username" <> '' AND "username" = lower\(btrim\("username"\)\)\)/);
    expect(sql).toContain('RegistrationRequest_one_pending_email');
    expect(sql).toContain("WHERE \"status\" = 'PENDING'");
  });

  test('invalidates unconvertible bcrypt bearer tokens and enforces exact primary mailbox state', () => {
    expect(sql).toContain('DELETE FROM "Session"');
    expect(sql).toContain('DELETE FROM "PasswordResetToken"');
    expect(sql).toContain('MailboxAccount_one_primary_per_user');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('primary_count <> 1');
  });
});
