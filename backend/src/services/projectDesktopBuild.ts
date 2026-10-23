import { readProjectTextFile } from './projectSurfacePolicy';
import { DesktopProjectContractError, desktopSourceFileInventory, parseDesktopProjectDescriptor, requireDesktopBuiltFile, validateDesktopProjectSource, type DesktopProjectDescriptor } from './projectDesktopContract';
import { desktopDependencyPolicy, type DesktopDependencyPolicy } from './projectDesktopToolchain';

export const DESKTOP_BUILD_RECEIPT = '.portal-desktop-build.json';
export interface DesktopBuildReceipt {
  version: 1;
  descriptor: DesktopProjectDescriptor;
  executable: string;
  args: string[];
  node: boolean;
  runtime?: 'electron-44.9.0' | null;
  libraryPath: string | null;
  qtPluginPath: string | null;
}

/** Runs only inside the admitted non-root toolchain workload. Never evaluate this
 * script in the backend. The image carries warm caches for the built-in starters;
 * `brokered` fetches anything else through the Project egress proxy, while
 * `offline` allows only those caches. Lockfiles are enforced in both modes. */
export const DESKTOP_BUILD_SCRIPT = String.raw`
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const descriptor = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString());
const phase = process.argv[2];
const sourceFiles = JSON.parse(Buffer.from(process.argv[3] || 'W10', 'base64url').toString());
const policy = process.argv[4] === 'brokered' ? 'brokered' : 'offline';
const offline = policy === 'offline';
const workspace = process.cwd(), seed = '/opt/desktop-seed';
const cache = path.join(workspace, '.portal-build-cache');
fs.mkdirSync(cache, {recursive:true});
const env = {...process.env, CARGO_BUILD_JOBS:'2', CARGO_HOME:path.join(cache,'cargo'), CARGO_TARGET_DIR:path.join(workspace,'target'),
  NPM_CONFIG_CACHE:path.join(cache,'npm'), PIP_DISABLE_PIP_VERSION_CHECK:'1', ELECTRON_SKIP_BINARY_DOWNLOAD:'1'};
function run(command, args) {
  console.log('> '+command+' '+args.join(' '));
  const result = cp.spawnSync(command,args,{env,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command+' failed ('+(result.status===null?result.signal:result.status)+'). '+(offline
    ? 'This server builds Desktop Projects offline, so only the toolchain cache is available. A dependency outside it needs brokered dependencies enabled by the administrator.'
    : 'See the output above. Dependencies download through the Portal egress proxy and must match the lockfile.'));
}
function capture(command,args) {
  console.log('> '+command+' '+args.join(' '));
  const result=cp.spawnSync(command,args,{env,encoding:'utf8',maxBuffer:16*1024*1024});
  if(result.error || result.status!==0) {
    if(command==='cargo' && args.includes('--message-format=json')) for(const line of (result.stdout||'').split('\n')) {
      try {const message=JSON.parse(line);if(message.reason==='compiler-message'&&message.message?.rendered)console.error(message.message.rendered);}catch{}
    }
    throw result.error || new Error(result.stderr || command+' failed');
  }
  return result.stdout;
}
function seedCache(name, target) {
  const source=path.join(seed,name), dest=path.join(cache,target||name);
  if(fs.existsSync(source)) fs.cpSync(source,dest,{recursive:true,dereference:false,force:false,errorOnExist:false});
}
const npmMode=offline?'--offline':'--prefer-offline', cargoNetwork=offline?['--offline']:[];
const seedCargo=()=>seedCache('cargo-home/registry','cargo/registry');
let executable='',args=[],node=false,runtime=null,qtPluginPath=null,libraryPath=null;
const out=path.join(workspace,'.desktop-out');
function ensureOut() { fs.mkdirSync(out,{recursive:true}); }
function bundleLibraries(binary) {
  ensureOut(); const directory=path.join(out,'lib');fs.mkdirSync(directory,{recursive:true});
  const output=capture('ldd',[binary]);
  for(const line of output.split('\n')) {
    if(line.includes('not found')) throw new Error('Missing native build dependency: '+line.trim());
    const match=line.match(/=>\s+(\/[^\s]+)\s/); if(!match)continue;
    const source=match[1],name=path.basename(source);
    if(/^(libc|libm|libdl|libpthread|librt|libresolv|libutil)\.so\./.test(name))continue;
    const destination=path.join(directory,name);
    if(fs.existsSync(destination)) {
      if(!fs.readFileSync(destination).equals(fs.readFileSync(source)))throw new Error('Conflicting native library '+name);
    } else fs.copyFileSync(source,destination);
  }
  libraryPath='.desktop-out/lib';
}
function bundleDynamicLibrary(name) {
  const entry=capture('/sbin/ldconfig',['-p']).split('\n').find(line=>line.trim().startsWith(name+' '));
  if(!entry)throw new Error('Missing supplied graphics library '+name);
  const source=entry.split('=>')[1].trim();
  bundleLibraries(source);fs.copyFileSync(source,path.join(out,'lib',name));
}
if(phase==='resolve') {
  if(descriptor.language==='typescript') { seedCache('npm');run('npm',['install','--package-lock-only',npmMode,'--ignore-scripts','--no-audit','--no-fund']); }
  else if(descriptor.language==='rust') { seedCargo();run('cargo',['generate-lockfile',...cargoNetwork]); }
  else throw new Error('This language does not need a generated dependency lockfile');
  process.exit(0);
}
if(descriptor.language==='typescript') {
  seedCache('npm');
  if(!fs.existsSync('package-lock.json'))throw new Error('Missing package-lock.json. Run Install dependencies for this Project to create it, then keep the lockfile with the source.');
  run('npm',['ci',npmMode,'--include=dev','--no-audit','--no-fund']);
  run('node',['node_modules/typescript/bin/tsc','--project','tsconfig.json',...(phase==='check'?['--noEmit']:[])]);
  if(descriptor.framework==='electron' && phase==='build') {
    const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
    if((pkg.dependencies?.electron||pkg.devDependencies?.electron)!=='44.9.0')throw new Error('Desktop GUI apps run on the server-managed Electron 44.9.0. Set electron to exactly 44.9.0 in package.json.');
    // Executable comes only from the admitted host runtime, never project output.
    runtime='electron-44.9.0';executable=descriptor.entry;args=[];
    if(fs.existsSync(path.join(out,'electron')))fs.rmSync(path.join(out,'electron'),{recursive:true});
  } else {
    executable=descriptor.entry;node=true;
    if(phase==='build') {
      ensureOut();fs.copyFileSync(process.execPath,path.join(out,'node'));fs.chmodSync(path.join(out,'node'),0o755);
      bundleLibraries(path.join(out,'node'));
    }
  }
} else if(descriptor.language==='rust') {
  seedCargo();
  const cargoConfig=cargoNetwork;
  // A lockfile is mandatory for builds; resolve is an explicit dependency phase.
  if(!fs.existsSync('Cargo.lock'))throw new Error('Missing Cargo.lock. Run Install dependencies for this Project to create it, then keep the lockfile with the source.');
  const select=['--bin',descriptor.binary,...(descriptor.package?['--package',descriptor.package]:[])];
  const metadata=JSON.parse(capture('cargo',['metadata','--format-version=1','--locked',...cargoConfig]));
  for(const pkg of metadata.packages) {
    if(pkg.source===null) {
      const manifest=fs.realpathSync(pkg.manifest_path);
      if(!manifest.startsWith(workspace+path.sep))throw new Error('External Cargo path dependencies are not supported');
    }
  }
  if(phase==='check')run('cargo',['check','--locked',...cargoConfig,...select]);
  else {
    const output=capture('cargo',['build','--release','--locked','--message-format=json',...cargoConfig,...select]);
    const messages=output.split('\n').filter(Boolean).map(line=>JSON.parse(line));
    for(const message of messages)if(message.reason==='compiler-message' && message.message.rendered)console.log(message.message.rendered);
    const bins=messages.filter(message=>message.reason==='compiler-artifact'&&message.target.name===descriptor.binary&&message.executable);
    const paths=[...new Set(bins.map(message=>message.executable))];
    if(paths.length!==1)throw new Error('Cargo must select exactly one executable; set package and binary');
    const relative=path.relative(workspace,fs.realpathSync(paths[0]));
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Cargo executable escaped workspace');
    ensureOut();fs.copyFileSync(paths[0],path.join(out,'application'));fs.chmodSync(path.join(out,'application'),0o755);
    executable='.desktop-out/application';bundleLibraries(executable);
    if(descriptor.framework==='egui')for(const library of ['libxkbcommon-x11.so.0','libxkbcommon.so.0','libEGL.so.1','libGL.so.1'])bundleDynamicLibrary(library);
  }
} else if(descriptor.language==='python') {
  run('python3',['-m','venv','.venv']);
  run('.venv/bin/python',['-m','pip','install',...(offline?['--no-index']:[]),'--find-links',path.join(seed,'wheels'),'pyinstaller==6.16.0',...(fs.existsSync('requirements.txt')?['-r','requirements.txt']:[])]);
  run('.venv/bin/python',['-m','py_compile',...sourceFiles]);
  if(phase==='build') {
    run('.venv/bin/python',['-m','PyInstaller','--noconfirm','--clean','--onedir','--name','application','--distpath','.desktop-out','--workpath','build/pyinstaller','--specpath','build',descriptor.entry]);
    executable='.desktop-out/application/application';
  }
} else if(descriptor.language==='cpp') {
  fs.mkdirSync('build/.cmake/api/v1/query',{recursive:true});fs.writeFileSync('build/.cmake/api/v1/query/codemodel-v2','');
  run('cmake',['-S','.','-B','build','-DCMAKE_BUILD_TYPE=Release']);
  run('cmake',['--build','build','--parallel','2','--target',descriptor.binary]);
  if(phase==='build') {
    const reply='build/.cmake/api/v1/reply';
    const indices=fs.readdirSync(reply).filter(name=>/^index-.*\.json$/.test(name)).sort();
    const index=JSON.parse(fs.readFileSync(path.join(reply,indices[indices.length-1]),'utf8'));
    const model=JSON.parse(fs.readFileSync(path.join(reply,index.reply['codemodel-v2'].jsonFile),'utf8'));
    const target=model.configurations.flatMap(config=>config.targets).filter(target=>target.name===descriptor.binary);
    if(target.length!==1)throw new Error('CMake target is not an unambiguous executable');
    const detail=JSON.parse(fs.readFileSync(path.join(reply,target[0].jsonFile),'utf8'));
    if(detail.type!=='EXECUTABLE'||detail.artifacts.length!==1)throw new Error('CMake target did not produce one executable');
    const binary=fs.realpathSync(path.join(workspace,'build',detail.artifacts[0].path));
    if(!binary.startsWith(workspace+path.sep))throw new Error('CMake executable escaped workspace');
    ensureOut();fs.copyFileSync(binary,path.join(out,'application'));fs.chmodSync(path.join(out,'application'),0o755);
    executable='.desktop-out/application';bundleLibraries(executable);
    if(descriptor.framework==='qt') {
      const plugin=capture('qtpaths6',['--query','QT_INSTALL_PLUGINS']).trim()+'/platforms/libqxcb.so';
      fs.mkdirSync(path.join(out,'platforms'),{recursive:true});fs.copyFileSync(plugin,path.join(out,'platforms/libqxcb.so'));bundleLibraries(plugin);
      qtPluginPath='.desktop-out/platforms';
    }
  }
}
if(phase==='build') {
  ensureOut();
  if(!fs.existsSync(path.join(seed,'notices')))throw new Error('The Desktop toolchain is missing its third-party notices. An administrator can rebuild it with install.sh --install-desktop-toolchain.');
  fs.cpSync(path.join(seed,'notices'),path.join(out,'notices'),{recursive:true});
  fs.writeFileSync('.portal-desktop-build.json',JSON.stringify({version:1,descriptor,executable,args,node,runtime,libraryPath,qtPluginPath})+'\n');
}
`;

export function readDesktopBuildReceipt(root: string, descriptor: DesktopProjectDescriptor): DesktopBuildReceipt {
  const text = readProjectTextFile(root, DESKTOP_BUILD_RECEIPT, { maxBytes: 16 * 1024 });
  let value: any;
  try { value = JSON.parse(text || ''); } catch { throw new DesktopProjectContractError('Desktop build did not return a receipt'); }
  if (value.version !== 1 || JSON.stringify(parseDesktopProjectDescriptor(value.descriptor)) !== JSON.stringify(descriptor)
    || typeof value.executable !== 'string' || typeof value.node !== 'boolean'
    || !Array.isArray(value.args) || value.args.length > 1
    || value.args.some((arg: unknown) => typeof arg !== 'string' || arg !== descriptor.entry)
    || ![null, '.desktop-out/lib'].includes(value.libraryPath)
    || ![null, '.desktop-out/platforms'].includes(value.qtPluginPath)) {
    throw new DesktopProjectContractError('Desktop build receipt does not match the selected project');
  }
  if (descriptor.framework === 'electron') {
    if (value.runtime !== 'electron-44.9.0' || value.node || value.executable !== descriptor.entry || value.args.length) {
      throw new DesktopProjectContractError('Electron must use the server-managed runtime');
    }
  } else if (value.runtime != null) throw new DesktopProjectContractError('Unexpected Desktop runtime');
  const expectedExecutable = descriptor.language === 'typescript' ? descriptor.entry
    : descriptor.language === 'python' ? '.desktop-out/application/application' : '.desktop-out/application';
  if (value.executable !== expectedExecutable || value.args.length !== 0
    || value.node !== (descriptor.language === 'typescript' && descriptor.framework === 'node')) {
    throw new DesktopProjectContractError('Desktop build entry does not match its language adapter');
  }
  requireDesktopBuiltFile(root, value.executable, !value.node && !value.runtime);
  if (value.node) requireDesktopBuiltFile(root, '.desktop-out/node', true);
  for (const arg of value.args) requireDesktopBuiltFile(root, arg);
  return value as DesktopBuildReceipt;
}

/** Server-selected build argv: the dependency policy is host configuration, never request input. */
export function desktopBuildArgs(descriptor: DesktopProjectDescriptor, phase: 'check' | 'build' | 'resolve', sourceFiles: string[], policy: DesktopDependencyPolicy): string[] {
  return ['-e', DESKTOP_BUILD_SCRIPT, Buffer.from(JSON.stringify(descriptor)).toString('base64url'), phase,
    Buffer.from(JSON.stringify(sourceFiles)).toString('base64url'), policy];
}

export async function buildDesktopProject(input: {
  actorId: string; projectId: string; workspace: string;
  descriptor: DesktopProjectDescriptor; phase: 'check' | 'build' | 'resolve'; signal?: AbortSignal; onOutput?: (chunk: string) => void;
}): Promise<{ output: string; receipt: DesktopBuildReceipt | null }> {
  const { runProjectLifecycleCommand } = await import('./project-lifecycle.service');
  validateDesktopProjectSource(input.workspace, input.descriptor);
  const sourceFiles = input.descriptor.language === 'python' ? desktopSourceFileInventory(input.workspace, ['.py']) : [];
  const policy = desktopDependencyPolicy();
  const output = await runProjectLifecycleCommand({
    actorId: input.actorId, projectId: input.projectId, workspace: input.workspace,
    command: 'node', args: desktopBuildArgs(input.descriptor, input.phase, sourceFiles, policy),
    desktopBuild: true, signal: input.signal, onOutput: input.onOutput, timeoutMs: 15 * 60_000,
    // Brokered traffic leaves only through the per-workload egress proxy.
    network: policy === 'brokered', nameHint: 'desktop-' + input.phase,
  });
  return { output, receipt: input.phase === 'build' ? readDesktopBuildReceipt(input.workspace, input.descriptor) : null };
}
