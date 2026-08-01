import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { PassThrough } from 'stream';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('archiver');

const INSTALLER_DIR = path.resolve(__dirname, '../../../installer');
const BUNDLE_MEMBERS = [
  'Start-Here.cmd',
  'Setup-OllamaTailnet.ps1',
  'README.txt',
] as const;
const SOURCE_FILES: Record<typeof BUNDLE_MEMBERS[number], string> = {
  'Start-Here.cmd': path.join(INSTALLER_DIR, 'Start-Here.cmd'),
  'Setup-OllamaTailnet.ps1': path.join(INSTALLER_DIR, 'Setup-OllamaTailnet.ps1'),
  'README.txt': path.join(INSTALLER_DIR, 'ollama-tailnet-README.txt'),
};

describe('Remote GPU native Tailscale Serve setup bundle', () => {
  it('has exactly the three source files packed by the authenticated route', () => {
    expect(Object.keys(SOURCE_FILES).sort()).toEqual([...BUNDLE_MEMBERS].sort());
    for (const filePath of Object.values(SOURCE_FILES)) {
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it('assembles one zip containing the native setup and no helper runtime', async () => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve, reject) => {
      sink.on('end', resolve);
      archive.on('error', reject);
    });
    archive.pipe(sink);
    for (const member of BUNDLE_MEMBERS) {
      archive.file(SOURCE_FILES[member], { name: member });
    }
    await archive.finalize();
    await done;

    const zip = Buffer.concat(chunks);
    const text = zip.toString('latin1');
    for (const member of BUNDLE_MEMBERS) expect(text).toContain(member);
    expect(text).not.toContain('ollama-tailnet-helper.mjs');
    expect(text).not.toContain('ollama-tailnet-helper-core.cjs');
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('configures one durable fixed-port Tailscale forward to loopback Ollama', () => {
    const ps1 = readFileSync(SOURCE_FILES['Setup-OllamaTailnet.ps1'], 'utf8');
    expect(ps1).toContain("$script:SetupBuild = '20260726-native6'");
    expect(ps1).toContain("$env:OS -ne 'Windows_NT'");
    expect(ps1).toContain('https://tailscale.com/download');
    expect(ps1).toContain('https://ollama.com/download');
    expect(ps1).toContain("$script:ServePort = 11435");
    expect(ps1).toContain("$script:ServeTarget = 'tcp://127.0.0.1:11434'");
    expect(ps1).toContain("'--bg'");
    expect(ps1).toContain('"--tcp=$($script:ServePort)"');
    expect(ps1).toContain("@('serve', 'status', '--json')");
    expect(ps1).toContain('$PortHandlers[0].Handler.TCPForward');
    expect(ps1).toContain('$Config.Services.PSObject.Properties');
    expect(ps1).toContain("$Existing.Scope -ne 'device'");
    expect(ps1).toContain("$Existing.Forward -ne '127.0.0.1:11434'");
    expect(ps1).toContain('Nothing was overwritten.');
    expect(ps1).toContain('function Find-TailscaleServeApprovalUrl');
    expect(ps1).toContain(
      "'https://[^\\x00-\\x20\\x7f''\"<>]{1,2048}'",
    );
    expect(ps1).toContain(
      "$Uri.Host -ceq 'login.tailscale.com'",
    );
    expect(ps1).toContain("$Uri.Scheme -ceq 'https'");
    expect(ps1).toContain('[string]::IsNullOrEmpty($Uri.UserInfo)');
    expect(ps1).toContain('$Uri.Port -eq 443');
    expect(ps1).toMatch(/one-time browser approval before this PC can use Serve/i);
    expect(ps1).toMatch(/Approve Serve there, then run Start-Here\.cmd again/i);
    expect(ps1).not.toMatch(/Start-Process[^\r\n]*\$ApprovalUrl/iu);
    const serveOutputCapture = ps1.indexOf('$ServeOutput = $Serve.Output');
    const approvalGuidance = ps1.indexOf(
      'Write-TailscaleServeApprovalGuidance $Serve.Output',
    );
    expect(serveOutputCapture).toBeGreaterThanOrEqual(0);
    expect(approvalGuidance).toBeGreaterThan(serveOutputCapture);
    const existingRead = ps1.indexOf('$Existing = Read-ServeForward $Tailscale');
    const conflictCheck = ps1.indexOf(
      "$Existing.Scope -ne 'device'",
    );
    const serveMutation = ps1.indexOf(
      '$Serve = Invoke-Tailscale $Tailscale',
      existingRead,
    );
    expect(existingRead).toBeGreaterThanOrEqual(0);
    expect(conflictCheck).toBeGreaterThan(existingRead);
    expect(serveMutation).toBeGreaterThan(conflictCheck);
    expect(ps1).toContain("'ip', '-4'");
    expect(ps1).toContain('tailscale serve --tcp=$($script:ServePort) off');
    expect(ps1).not.toMatch(/--pair-|--service-/i);
    expect(ps1).toMatch(/no Node helper, pairing secret, scheduled/i);
    expect(ps1).not.toContain('serve reset');
    expect(ps1).toMatch(/\}\s*finally\s*\{[\s\S]*Read-Host 'Press Enter to close this window'/);
    expect(ps1).toContain('$script:SetupSucceeded = $false');
    expect(ps1).toContain('$script:SetupSucceeded = $true');
    expect(ps1).toMatch(
      /if \(\$script:SetupSucceeded\) \{\s*exit 0\s*\}\s*exit 1\s*$/u,
    );
    expect(ps1.lastIndexOf('$script:SetupSucceeded = $true'))
      .toBeGreaterThan(ps1.indexOf('Return to the Portal:'));
  });

  it('uses one fail-closed UAC relay for setup and retirement without persistent or duplicate setup windows', () => {
    const ps1 = readFileSync(SOURCE_FILES['Setup-OllamaTailnet.ps1'], 'utf8');
    expect(ps1).toContain('[switch] $ElevationRelaunch');
    expect(ps1).toContain('function Test-Administrator');
    expect(ps1).toContain(
      '[Security.Principal.WindowsBuiltInRole]::Administrator',
    );
    expect(ps1).toContain('function Invoke-ElevatedSetup');
    expect(ps1).toContain("$ScriptPath -notmatch '^[A-Za-z]:\\\\'");
    expect(ps1).toContain(
      'Extract the setup zip to a local Windows drive before requesting Administrator rights.',
    );
    expect(ps1.match(/Start-Process/gu)).toHaveLength(1);
    expect(ps1).toContain('-Verb RunAs');
    expect(ps1).toContain('-Wait');
    expect(ps1).toContain('-PassThru');
    expect(ps1).not.toContain('-NoExit');
    expect(ps1).toContain("'-ElevationRelaunch'");
    expect(ps1).toMatch(
      /if \(\$RetireLegacyHelper\) \{\s*\$Arguments \+= '-RetireLegacyHelper'\s*\}/u,
    );
    expect(ps1).toContain(
      '$script:ElevationExitCode = Invoke-ElevatedSetup',
    );
    expect(ps1).toContain('$script:SkipClosePrompt = $true');
    expect(ps1).toMatch(
      /if \(-not \$script:SkipClosePrompt\) \{\s*Write-Host ''\s*\[void\]\(Read-Host 'Press Enter to close this window'\)\s*\}/u,
    );
    expect(ps1).toMatch(
      /if \(\$null -ne \$script:ElevationExitCode\) \{\s*exit \$script:ElevationExitCode\s*\}/u,
    );
    expect(ps1).toMatch(
      /one-time UAC relaunch did not produce an Administrator token/i,
    );
    const recursionGuard = ps1.lastIndexOf('if ($ElevationRelaunch) {');
    const elevationCall = ps1.lastIndexOf(
      '$script:ElevationExitCode = Invoke-ElevatedSetup',
    );
    expect(recursionGuard).toBeGreaterThanOrEqual(0);
    expect(elevationCall).toBeGreaterThan(recursionGuard);
  });

  it('retains legacy authority during setup and permits only explicit post-activation retirement', () => {
    const ps1 = readFileSync(SOURCE_FILES['Setup-OllamaTailnet.ps1'], 'utf8');
    expect(ps1).toContain('[switch] $RetireLegacyHelper');
    expect(ps1).toContain(
      "$script:LegacyCleanupCommand = 'Start-Here.cmd --retire-legacy-helper'",
    );
    expect(ps1).toContain(
      "$script:LegacyTaskName = 'BridgesLLM-OllamaTailnetHelper-v1'",
    );
    expect(ps1).toContain(
      '^version=[0-9]{1,4};generation=[1-9][0-9]{0,15};helperId=[A-Za-z0-9_-]{16,128}$',
    );
    expect(ps1).toContain('ollama-tailnet-helper\\.mjs)" --stored$');
    expect(ps1).toContain("[IO.Path]::GetFileName($Execute) -ine 'node.exe'");
    expect(ps1).toContain('$TaskSid -cne $CurrentSid');
    expect(ps1).toContain("[string]$Task.Principal.RunLevel -cne 'Limited'");
    expect(ps1.match(/-TaskPath '\\'/gu)).toHaveLength(4);
    expect(ps1).toContain("'OllamaTailnetHelper'");
    expect(ps1).toContain("$Item.Name -ceq 'pairing-store.dpapi'");
    expect(ps1).toContain("$Item.Name -ceq '.pairing-store.lock'");
    expect(ps1).toContain("'^\\.pairing-tmp-[a-f0-9]{24}$'");
    expect(ps1).toContain(
      "Read-Host 'Type RETIRE to remove only these exact legacy BridgesLLM items, or press Enter to stop'",
    );
    expect(ps1).toMatch(/legacy helper remains live until the native Portal connection is active/i);
    expect(ps1).toMatch(/Existing Agent Chat continues through it until native Connect commits/i);
    expect(ps1).toMatch(/Native inventory, downloads, and model switching become available after Connect/i);
    expect(ps1).toMatch(/Setup performs no legacy task, state-folder, or pairing mutation/i);
    expect(ps1).toContain('Unregister-ScheduledTask');
    expect(ps1).toContain('Remove-Item -LiteralPath $File -Force');
    expect(ps1).toContain('Remove-Item -LiteralPath $Residue.Folder -Force');
    expect(ps1).not.toMatch(/Remove-Item[^\r\n]*-Recurse/iu);
    expect(ps1).not.toMatch(/Remove-Item[^\r\n]*(?:LOCALAPPDATA|BridgesLLM['"]?\s*$)/iu);
    const existingRead = ps1.indexOf(
      '$Existing = Read-ServeForward $Tailscale',
    );
    const retirementBranch = ps1.indexOf(
      'if ($RetireLegacyHelper) {',
      existingRead,
    );
    const listenerRequirement = ps1.indexOf(
      'if (-not $Existing.Present)',
      retirementBranch,
    );
    const legacyRetirement = ps1.indexOf(
      'if (-not (Remove-ExactLegacyHelperResidue))',
      retirementBranch,
    );
    expect(existingRead).toBeGreaterThanOrEqual(0);
    expect(retirementBranch).toBeGreaterThan(existingRead);
    expect(listenerRequirement).toBeGreaterThan(retirementBranch);
    expect(legacyRetirement).toBeGreaterThan(listenerRequirement);
    expect(ps1.indexOf(
      'if (-not (Remove-ExactLegacyHelperResidue))',
      legacyRetirement + 1,
    )).toBe(-1);
    expect(ps1.slice(0, retirementBranch)).not.toContain(
      'if (-not (Remove-ExactLegacyHelperResidue))',
    );
    expect(ps1).toMatch(/native Tailscale Serve listener remains configured and was not changed/i);
  });

  it('ships a one-shot double-click launcher that preserves the elevated exit code', () => {
    const cmd = readFileSync(SOURCE_FILES['Start-Here.cmd'], 'utf8');
    expect(cmd).toContain('-ExecutionPolicy Bypass');
    expect(cmd).toContain('Setup-OllamaTailnet.ps1');
    expect(cmd).toContain('set "setup_rc=%errorlevel%"');
    expect(cmd).toContain('exit /b %setup_rc%');
    expect(cmd).toContain('if /I "%~1"=="--retire-legacy-helper"');
    expect(cmd).toContain('set "setup_args=-RetireLegacyHelper"');
    expect(cmd).toContain('exit /b 64');
    expect(cmd).not.toContain('%*');
    expect(cmd).toMatch(
      /set "setup_rc=%errorlevel%"\s*exit \/b %setup_rc%\s*$/u,
    );
    expect(cmd).not.toContain('-NoExit');
    expect(cmd).not.toMatch(/node(?:\.exe)?/i);
    expect(cmd).toMatch(/one UAC prompt[\s\S]*Administrator terminal/i);
    const setupPath = cmd.slice(cmd.indexOf(':run_setup'));
    expect(setupPath).not.toContain('pause');
  });

  it('documents model management, the narrow Grant, and scoped removal', () => {
    const readme = readFileSync(SOURCE_FILES['README.txt'], 'utf8');
    const normalizedReadme = readme.replace(/\s+/gu, ' ');
    expect(readme).toContain('Start-Here.cmd');
    expect(normalizedReadme).toMatch(
      /local Windows drive.*Tailscale says Serve commands should run in an Administrator terminal/i,
    );
    expect(normalizedReadme).toMatch(
      /one Windows UAC prompt.*Administrator PowerShell window/i,
    );
    expect(normalizedReadme).toMatch(
      /waits for the one Administrator PowerShell setup.*exact result/i,
    );
    expect(readme).toMatch(/one-time[\s\S]*https:\/\/login\.tailscale\.com[\s\S]*approve[\s\S]*run Start-Here\.cmd again/i);
    expect(readme).toContain('tailscale serve --bg --tcp=11435 tcp://127.0.0.1:11434');
    expect(readme).toContain('tailscale serve --tcp=11435 off');
    expect(readme).toContain('Browse models');
    expect(readme).toContain('Grant');
    expect(readme).toContain('Do not use "tailscale serve reset"');
    expect(readme).toContain('BridgesLLM-OllamaTailnetHelper-v1');
    expect(readme).toMatch(/Normal setup never removes the older helper/i);
    expect(readme).toContain('Start-Here.cmd --retire-legacy-helper');
    expect(readme).toMatch(/Only after the Portal shows this PC as the active native Remote GPU/i);
    expect(readme).toMatch(/asking you to type RETIRE/i);
    expect(normalizedReadme).toMatch(
      /Retirement uses the same Administrator check.*passes only the retirement switch/i,
    );
    expect(normalizedReadme).toMatch(
      /never falls back to unelevated cleanup or opens another elevation window/i,
    );
    expect(readme).not.toMatch(/--pair-|--service-/i);
    expect(readme).toMatch(/no BridgesLLM helper service, Node\.js dependency, pairing secret/i);
  });
});
