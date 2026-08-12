import fs from 'fs';
import path from 'path';

describe('Project dependency promotion decision migration', () => {
  const migration = fs.readFileSync(path.join(
    __dirname,
    '../../prisma/migrations/20260812_project_dependency_promotion_decision/migration.sql',
  ), 'utf8');

  test('retains actor and Project proof but deliberately snapshots Session without a relation', () => {
    expect(migration).toContain('FOREIGN KEY ("actorUserId") REFERENCES "User"("id")');
    expect(migration).toContain('FOREIGN KEY ("workspaceOwnerId") REFERENCES "User"("id")');
    expect(migration).toContain('FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id")');
    expect(migration.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g)).toHaveLength(3);
    expect(migration).not.toContain('FOREIGN KEY ("sessionId")');
  });

  test('serializes mutable authorization and exact active Project identity fields with SHARE locks', () => {
    expect(migration).toContain('FROM "User"');
    expect(migration).toContain('FOR SHARE;');
    expect(migration).toContain('actor_role NOT IN (\'OWNER\', \'SUB_ADMIN\', \'USER\')');
    expect(migration).toContain('ORDER BY "createdAt" ASC, "id" ASC');
    expect(migration).toContain('"sessionId" TEXT NOT NULL');
    expect(migration).toContain('Session snapshot is not active; sign in again');
    expect(migration).toContain('identity_row."lifecycleStatus" IS DISTINCT FROM \'DEPENDENCY_PROMOTING\'');
    for (const field of [
      'workspaceOwnerId', 'projectName', 'generation', 'canonicalRoot',
      'rootDevice', 'rootInode', 'rootBirthtimeNs',
    ]) expect(migration).toContain(`identity_row."${field}"`);
    for (const field of [
      'operationParentCanonicalRoot', 'operationParentDevice', 'operationParentInode',
      'operationParentBirthtimeNs', 'operationParentMode', 'operationParentUid',
      'operationParentGid',
    ]) expect(migration).toContain(`NEW."${field}" IS DISTINCT FROM OLD."${field}"`);
  });

  test('makes provenance immutable, permits only AUTHORIZED to APPLIED, and blocks live deletion', () => {
    expect(migration).toContain('Project dependency promotion decision snapshot is immutable');
    expect(migration).toContain('OLD."status" <> \'AUTHORIZED\' OR NEW."status" <> \'APPLIED\'');
    expect(migration).toContain('IF OLD."status" <> \'APPLIED\' THEN');
    expect(migration).toContain('Authorized Project dependency promotion decision cannot be deleted');
    expect(migration).toContain('CREATE UNIQUE INDEX "ProjectDependencyPromotionDecision_destination_key"');
    expect(migration).toContain('"manifest" JSONB NOT NULL');
    expect(migration).toContain('octet_length("manifest"::TEXT) BETWEEN 1 AND 131072');
    expect(migration).toContain('NEW."manifest" IS DISTINCT FROM OLD."manifest"');
  });
});
