import fs from 'fs';
import path from 'path';

describe('registration password contract', () => {
  it('enforces the same password-strength policy as setup, reset, and change-password', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/auth.ts'), 'utf8');
    const registrationRoute = source.slice(
      source.indexOf("router.post('/register'"),
      source.indexOf('// ── Profile', source.indexOf("router.post('/register'")),
    );

    expect(registrationRoute).toContain('validatePasswordStrength(password)');
    expect(registrationRoute).toContain("throw new AppError(400, strength.errors.join('. '))");
  });

  it('serializes active account creation against durable authorization transitions', () => {
    const authSource = fs.readFileSync(path.join(__dirname, '../routes/auth.ts'), 'utf8');
    const registrationRoute = authSource.slice(
      authSource.indexOf("router.post('/register'"),
      authSource.indexOf('// ── Profile', authSource.indexOf("router.post('/register'")),
    );
    const adminSource = fs.readFileSync(path.join(__dirname, '../routes/admin.ts'), 'utf8');
    const approvalRoute = adminSource.slice(
      adminSource.indexOf("router.post('/registration-requests/:id/approve'"),
      adminSource.indexOf("router.post('/registration-requests/:id/deny'"),
    );

    expect(registrationRoute).toContain('await assertNoProjectAuthorizationTransitionActive(tx)');
    expect(registrationRoute).toContain('Prisma.TransactionIsolationLevel.Serializable');
    expect(approvalRoute).toContain('await assertNoProjectAuthorizationTransitionActive(tx)');
    expect(approvalRoute).toContain('Prisma.TransactionIsolationLevel.Serializable');
  });
});
