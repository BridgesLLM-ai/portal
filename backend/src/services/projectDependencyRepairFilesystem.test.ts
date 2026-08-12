import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../config/env', () => ({ config: { portalProjectRuntimeImageId: '' } }));
jest.mock('../config/database', () => ({ prisma: {} }));

import {
  attestProjectDependencyRepairCleanupBeforeGoBit,
  buildProjectDependencyForceForwardMovePlan,
  cleanupProjectDependencyRepairDisplacement,
  forceForwardQuarantinedProjectDependencyPromotion,
  projectDependencyRepairCleanupPlanDigest,
  type ProjectDependencyRepairCheckpoint,
  type ProjectDependencyRepairMovePlan,
} from './project-lifecycle.service';
import {
  prepareProjectLifecycleArtifactPromotion,
  type ProjectLifecycleArtifactPromotionProjectProof,
} from './project-lifecycle.service';

describe('Project dependency force-forward filesystem crash convergence', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-repair-fs-'));
    fs.chmodSync(root, 0o700);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function fixture() {
    const ownerRoot = path.join(root, 'owner-a');
    const workspace = path.join(root, 'workspace');
    const destination = path.join(ownerRoot, 'project-a');
    fs.mkdirSync(path.join(workspace, 'node_modules', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(destination, 'node_modules', 'old-nested'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'new.js'), 'new');
    fs.writeFileSync(path.join(workspace, 'node_modules', 'nested', 'deep.js'), 'deep-new');
    fs.writeFileSync(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3}');
    fs.writeFileSync(path.join(workspace, '.deps-installed'), 'new-digest');
    fs.writeFileSync(path.join(destination, 'node_modules', 'old.js'), 'old');
    fs.writeFileSync(path.join(destination, 'node_modules', 'old-nested', 'deep.js'), 'deep-old');
    fs.writeFileSync(path.join(destination, 'package-lock.json'), '{"lockfileVersion":2}');
    fs.writeFileSync(path.join(destination, '.deps-installed'), 'old-digest');
    fs.chmodSync(ownerRoot, 0o700);
    const stat = fs.lstatSync(destination, { bigint: true });
    const proof: ProjectLifecycleArtifactPromotionProjectProof = {
      projectIdentityId: 'project-a-id',
      projectIdentityGeneration: 3,
      workspaceOwnerId: 'owner-a',
      projectName: 'project-a',
      canonicalRoot: fs.realpathSync.native(destination),
      rootDevice: stat.dev.toString(),
      rootInode: stat.ino.toString(),
      rootBirthtimeNs: stat.birthtimeNs.toString(),
    };
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      ['node_modules', 'package-lock.json', '.deps-installed'],
      proof,
    );
    const displacement = path.join(ownerRoot, '.bridgesllm-project-repair-test');
    fs.mkdirSync(displacement, { mode: 0o700 });
    fs.chmodSync(displacement, 0o700);
    const plan = buildProjectDependencyForceForwardMovePlan({
      manifest: promotion.manifest,
      displacementRoot: displacement,
    });
    return { destination, displacement, manifest: promotion.manifest, plan };
  }

  function persist(planRef: { current: ProjectDependencyRepairMovePlan }) {
    return (plan: ProjectDependencyRepairMovePlan) => {
      planRef.current = JSON.parse(JSON.stringify(plan));
    };
  }

  test.each([
    'before-displace-target:0',
    'after-displace-target:0',
    'before-promote:0',
    'after-promote:0',
    'after-all-new',
    'after-committed-journal',
  ] as ProjectDependencyRepairCheckpoint[])('resumes exact all-new after %s interruption', async (seam) => {
    const value = await fixture();
    const planRef = { current: value.plan };
    let interrupted = false;
    expect(() => forceForwardQuarantinedProjectDependencyPromotion({
      manifest: value.manifest,
      displacementRoot: value.displacement,
      movePlan: planRef.current,
      persistMovePlan: persist(planRef),
      checkpoint: (checkpoint) => {
        if (!interrupted && checkpoint === seam) {
          interrupted = true;
          throw new Error(`interrupted:${seam}`);
        }
      },
    })).toThrow(`interrupted:${seam}`);

    expect(() => forceForwardQuarantinedProjectDependencyPromotion({
      manifest: value.manifest,
      displacementRoot: value.displacement,
      movePlan: planRef.current,
      persistMovePlan: persist(planRef),
    })).not.toThrow();
    expect(fs.existsSync(path.join(value.destination, 'node_modules', 'old.js'))).toBe(false);
    expect(fs.readFileSync(path.join(value.destination, 'node_modules', 'new.js'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(value.destination, 'package-lock.json'), 'utf8'))
      .toBe('{"lockfileVersion":3}');
    expect(planRef.current.steps.every((step) => step.phase === 'MOVED')).toBe(true);
  });

  test('cleanup requires the authenticated cleanup digest and resumes deep partial deletion', async () => {
    const value = await fixture();
    const planRef = { current: value.plan };
    forceForwardQuarantinedProjectDependencyPromotion({
      manifest: value.manifest,
      displacementRoot: value.displacement,
      movePlan: planRef.current,
      persistMovePlan: persist(planRef),
    });
    expect(attestProjectDependencyRepairCleanupBeforeGoBit({
      manifest: value.manifest,
      displacementRoot: value.displacement,
      movePlan: planRef.current,
    })).toBe(projectDependencyRepairCleanupPlanDigest(planRef.current));

    const displacedDirectory = planRef.current.steps.find((step) => (
      step.kind === 'DISPLACE_TARGET' && step.artifact === 'node_modules'
    ));
    expect(displacedDirectory).toBeDefined();
    displacedDirectory!.phase = 'CLEANUP_INTENT';
    persist(planRef)(planRef.current);
    fs.rmSync(path.join(displacedDirectory!.destinationCanonicalPath, 'old-nested'), {
      recursive: true,
      force: false,
    });

    expect(() => cleanupProjectDependencyRepairDisplacement({
      manifest: value.manifest,
      displacementRoot: value.displacement,
      movePlan: planRef.current,
      persistMovePlan: persist(planRef),
    })).not.toThrow();
    expect(fs.existsSync(value.displacement)).toBe(false);
    expect(planRef.current.steps.filter((step) => step.kind !== 'PROMOTE_STAGED')
      .every((step) => step.phase === 'CLEANED')).toBe(true);
  });

  test('rejects staged recursive content drift before the repair go-bit', async () => {
    const value = await fixture();
    const staged = value.plan.steps.find((step) => step.kind === 'PROMOTE_STAGED');
    expect(staged).toBeDefined();
    fs.writeFileSync(path.join(staged!.sourceCanonicalPath, 'drift.js'), 'drift');
    expect(() => buildProjectDependencyForceForwardMovePlan({
      manifest: value.manifest,
      displacementRoot: value.displacement,
    })).toThrow(/changed|digest|generation/i);
  });
});
