import fs from 'fs';
import path from 'path';

// Owner schedules live in timer drop-ins plus the timers' enable state. They
// survive Portal updates only while the installer keeps writing default timers
// on fresh installs alone and never touches timer drop-ins or re-enables timers.
const installer = fs.readFileSync(path.resolve(__dirname, '../../../installer/install.sh'), 'utf8');

function functionBody(name: string): string {
  const start = installer.indexOf(`\n${name}() {\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  return installer.slice(start, installer.indexOf('\n}\n', start) + 3);
}

describe('installer preserves owner backup schedules', () => {
  it('writes and enables default timers only during a fresh install', () => {
    const references = installer.split('\n').filter((line) => /\bconfigure_backup_timers\b/.test(line));
    expect(references).toEqual([
      '  fresh_install_plan_add backups "Scheduling backups" configure_backup_timers',
      'configure_backup_timers() {',
    ]);
    const enables = installer.split('\n').filter((line) => /systemctl enable[^\n]*bridgesllm-backup/.test(line));
    expect(enables).toHaveLength(1);
    expect(functionBody('configure_backup_timers')).toContain(enables[0]);
  });

  it('lets updates replace only the backup service entry point', () => {
    expect(functionBody('complete_committed_update_transaction')).toContain('configure_backup_data_entrypoint');
    const entrypoint = functionBody('configure_backup_data_entrypoint');
    expect(entrypoint).toContain('bridgesllm-backup@.service.d');
    expect(entrypoint).not.toMatch(/\.timer|enable|disable/);
  });

  it('names the backup timers only where a fresh install writes them and uninstall removes them', () => {
    const lines = installer.split('\n');
    const owners = ['configure_backup_timers', 'remove_portal_backup_automation'].map((name) => {
      const start = lines.indexOf(`${name}() {`);
      expect(start).toBeGreaterThanOrEqual(0);
      return [start, lines.indexOf('}', start)];
    });
    const timerName = /bridgesllm-backup-(?:daily|comprehensive|monthly)\.timer|bridgesllm-backup-[$"*{]/;
    const elsewhere = lines.flatMap((line, index) => (timerName.test(line)
      && !owners.some(([start, end]) => index > start && index < end) ? [`${index + 1}: ${line.trim()}`] : []));
    expect(elsewhere).toEqual([]);
  });

  it('never writes or removes timer drop-ins', () => {
    expect(installer).not.toMatch(/bridgesllm-backup-[a-z]+\.timer\.d/);
    expect(installer).not.toContain('60-bridgesllm-portal-schedule.conf');
  });
});
