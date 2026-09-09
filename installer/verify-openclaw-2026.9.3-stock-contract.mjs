#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const CORE_NAME = "openclaw";
const CORE_VERSION = "2026.9.3";
const CORE_COMMIT = "1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7";
const CODEX_NAME = "@openclaw/codex";
const CODEX_VERSION = "2026.9.3";
const NODE_RANGE = ">=24.16.0 <25 || >=26.1.0";
const RUNS_STOCK_SHA256 = "4b06318761b7cb997caeed25f02f1bfe679b6360465a5d0ec29183b583ea6c90";
const RUNS_BRIDGED_SHA256 = RUNS_STOCK_SHA256;
const WATCHDOG_STOCK_SHA256 = "9c4200a8f6f6324277408a7437be215b122b4f92944a317e862bd237db2b1067";
const DELETE_SCHEMA_STOCK_SHA256 = "41325a6f1d67feea29d9ac59a6d37db03ad994c9a55798bdd46172463785e47b";
const DELETE_SCHEMA_BRIDGED_SHA256 = "7b5f05641d48948cbbee85372cf99c679caf6e6ef517797a049e452df33020d2";
const DELETE_HANDLER_STOCK_SHA256 = "5061d7fba26bc1777927f7e5117d21c7c6cf1e36d7ec9a956fe3e11b80761556";
const DELETE_HANDLER_BRIDGED_SHA256 = "1ae2ba33acf0273f1e7e7fbfd600983a58258e256ead4507638e1d09c2b22afe";
const RUNS_BACKUP_SUFFIX = ".bridgesllm-pending-input-v1.bak";
const HARD_DELETE_BACKUP_SUFFIX = ".bridgesllm-hard-delete-v1.bak";
const HARD_DELETE_MARKER = "bridgesllm-openclaw-hard-delete-transcript-2026.9.1-v1";
const PACKAGE_TARGET_MODE = 0o644;

const fail = (message) => {
  throw new Error(`OpenClaw ${CORE_VERSION} stock-contract verification failed: ${message}`);
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const readRegularFile = (filename) => {
  let metadata;
  try {
    metadata = fs.lstatSync(filename);
  } catch (error) {
    fail(`could not inspect ${filename}: ${error.message}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    fail(`expected one regular file at ${filename}`);
  }
  try {
    return fs.readFileSync(filename, "utf8");
  } catch (error) {
    fail(`could not read ${filename}: ${error.message}`);
  }
};

const readJson = (filename) => {
  try {
    const value = JSON.parse(readRegularFile(filename));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`expected an object in ${filename}`);
    }
    return value;
  } catch (error) {
    if (error.message?.startsWith("OpenClaw ")) throw error;
    fail(`invalid JSON in ${filename}: ${error.message}`);
  }
};

const resolvePackageRoot = (input, label) => {
  if (!input) fail(`${label} package directory was not provided`);
  let resolved;
  try {
    resolved = fs.realpathSync(input);
    if (!fs.lstatSync(resolved).isDirectory()) fail(`${label} package path is not a directory`);
  } catch (error) {
    if (error.message?.startsWith("OpenClaw ")) throw error;
    fail(`could not resolve ${label} package directory ${input}: ${error.message}`);
  }
  return resolved;
};

const resolveInside = (root, relative, label) => {
  const candidate = path.resolve(root, relative);
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch (error) {
    fail(`could not resolve ${label} at ${candidate}: ${error.message}`);
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(`${label} escapes its package root`);
  }
  return resolved;
};

const findUniqueBundle = (dist, prefix, markers, label) => {
  let names;
  try {
    names = fs.readdirSync(dist);
  } catch (error) {
    fail(`could not list ${dist}: ${error.message}`);
  }
  const candidates = names
    .filter((name) => name.startsWith(prefix) && /\.m?js$/.test(name))
    .map((name) => path.join(dist, name))
    .filter((filename) => {
      const text = readRegularFile(filename);
      return markers.every((marker) => text.includes(marker));
    });
  if (candidates.length !== 1) {
    fail(`expected exactly one ${label} bundle, found ${candidates.length}`);
  }
  return candidates[0];
};

const assertSyntax = (filename) => {
  const checked = spawnSync(process.execPath, ["--check", filename], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (checked.status !== 0) {
    fail(`JavaScript syntax check failed for ${filename}: ${(checked.stderr || checked.stdout).trim()}`);
  }
};

const assertNoLegacyMutationResidue = (packageRoot, allowedPortalFiles = new Set()) => {
  const forbiddenContent = [
    "bridgesllm-openclaw-pending-input-v1",
    "bridgesllm.openclaw.pending-input",
    "BRIDGESLLM_PENDING_INPUT_HOTFIX_MARKER",
    "bridgesllm-openclaw-active-steer",
    "bridgesllm-openclaw-provider-neutral-exact-run-steer",
    "bridgesllm-openclaw-exact-active-run-steer",
    "bridgesllm.openclaw.active-run-steer",
    "bridgesllm-openclaw-claude-ask-user-route",
    "BRIDGESLLM_CLAUDE_ASK_USER_ROUTE_MARKER",
  ];
  const stack = [path.join(packageRoot, "dist")];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      fail(`could not inspect stock package tree ${current}: ${error.message}`);
    }
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`unexpected symlink in stock dist tree: ${filename}`);
      if (entry.isDirectory()) {
        stack.push(filename);
        continue;
      }
      if (!entry.isFile()) fail(`unexpected non-file in stock dist tree: ${filename}`);
      if ((entry.name.includes(".bridgesllm") || /bridgesllm-.*\.bak|pending-input-v1\.bak/u.test(entry.name))
        && !allowedPortalFiles.has(path.resolve(filename))) {
        fail(`legacy hotfix artifact remains in stock package: ${filename}`);
      }
      if (/\.m?js$/u.test(entry.name)) {
        const text = readRegularFile(filename);
        const marker = forbiddenContent.find((value) => text.includes(value));
        if (marker && !allowedPortalFiles.has(path.resolve(filename))) {
          fail(`legacy binary mutation marker ${marker} remains in ${filename}`);
        }
      }
    }
  }
};

const assertExactFileHash = (filename, expected, label) => {
  const content = readRegularFile(filename);
  const observed = sha256(content);
  if (observed !== expected) fail(`${label} hash drifted: ${observed}`);
  return content;
};

const assertPackageTargetMetadata = (filename, label) => {
  const metadata = fs.lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.uid !== 0 || metadata.gid !== 0
    || (metadata.mode & 0o777) !== PACKAGE_TARGET_MODE) {
    fail(`${label} is not an exact root:root mode-0644 package file: ${filename}`);
  }
};

const assertRollbackBackup = (filename, suffix, expectedHash, label) => {
  const backup = `${filename}${suffix}`;
  const metadata = fs.lstatSync(backup);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o777) !== 0o600) {
    fail(`${label} rollback backup is unsafe: ${backup}`);
  }
  assertExactFileHash(backup, expectedHash, `${label} rollback backup`);
  return backup;
};

// A repeated maintenance operation snapshots the already-bridged baseline.
// Only a canonical, private, exact-target journal can select patched backup
// hashes; arbitrary package state never widens the stock backup contract.
const retainedBridgeBaseline = (root, targets) => {
  const journal = path.join(root, ".bridgesllm-portal-bridge-transaction-v1.json");
  let metadata;
  try { metadata = fs.lstatSync(journal); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o777) !== 0o600) {
    fail("unsafe Portal bridge journal");
  }
  const normal = {
    schema: "bridgesllm-openclaw-2026.9.1-portal-bridge-transaction-v1",
    packageRoot: root,
    targets: targets.map(([id, filename, stockHash, patchedHash, suffix]) => ({
      id, path: filename, stockSha256: stockHash, patchedSha256: patchedHash,
      backupPath: filename + suffix, backupSha256: stockHash,
    })),
  };
  const retained = {
    ...normal, schema: "bridgesllm-openclaw-retained-portal-bridge-transaction-v1",
    targets: normal.targets.map(entry => ({ ...entry, backupSha256: entry.patchedSha256 })),
  };
  const raw = readRegularFile(journal);
  if (raw === JSON.stringify(normal) + "\n") return false;
  if (raw === JSON.stringify(retained) + "\n") return true;
  fail("Portal bridge journal does not bind this exact baseline");
};

const importFresh = async (filename) => import(`${pathToFileURL(filename).href}?stock-contract=${Date.now()}-${Math.random()}`);

const assertQuestionRuntimeBehavior = async (runtimeModule) => {
  const imported = await importFresh(runtimeModule);
  const runtime = imported.questionGatewayRuntime;
  const createStore = imported.createQuestionReactionTargetStore;
  if (!runtime || typeof createStore !== "function") fail("question Gateway runtime exports are missing");
  if (JSON.stringify(runtime.reactionEmojis) !== JSON.stringify(["1️⃣", "2️⃣", "3️⃣", "4️⃣"])) {
    fail("question Gateway reaction choices drifted");
  }
  if (runtime.resolveReactionIndex("2️⃣") !== 1 || runtime.resolveReactionIndex("not-a-choice") !== undefined) {
    fail("question Gateway reaction index behavior drifted");
  }

  let registeredDelivery;
  let resolution;
  const store = createStore({
    channel: "portal-contract",
    channelDisplayName: "Portal contract",
    ttlMs: 60_000,
    buildKey: (identity) => identity?.key,
    registerChannelDelivery: (delivery) => { registeredDelivery = delivery; },
    resolveReaction: async (params) => {
      resolution = params;
      return { status: "answered", questionId: "question_1", optionValue: params.optionValue };
    },
  });
  const identity = { key: "contract-target" };
  if (!store.register({ questionId: `ask_${"a".repeat(32)}`, optionValues: ["alpha", "beta"] }, identity)) {
    fail("question reaction store rejected a valid target");
  }
  if (!store.has([identity]) || !registeredDelivery || typeof registeredDelivery.finalize !== "function") {
    fail("question reaction store did not retain a registered target");
  }
  if (!await store.resolve({ identities: [identity], optionIndex: 1, cfg: {}, senderId: "portal" })) {
    fail("question reaction store did not consume a valid choice");
  }
  if (resolution?.optionValue !== "beta" || resolution?.questionId !== `ask_${"a".repeat(32)}`) {
    fail("question reaction store did not map the choice to its canonical option value");
  }
};

const assertClaudeBehavior = async (authorizerModule) => {
  const imported = await importFresh(authorizerModule);
  const factories = Object.values(imported).filter((value) => typeof value === "function");
  if (factories.length !== 1) fail(`expected one Claude user-input factory export, found ${factories.length}`);
  let calls = 0;
  let request;
  const authorizer = factories[0]({
    requestUserInput: async (params) => {
      calls += 1;
      request = params;
      return { status: "answered", answers: { question_1: ["Second"] } };
    },
  });
  if (!authorizer || typeof authorizer.authorize !== "function") fail("Claude user-input authorizer is missing");
  const params = {
    toolUseId: "tool-contract-1",
    input: {
      questions: [{
        header: "Choice",
        question: "Which option?",
        multiSelect: false,
        options: [
          { label: "First", description: "First option" },
          { label: "Second", description: "Second option" },
        ],
      }],
    },
  };
  const first = authorizer.authorize(params);
  const duplicate = authorizer.authorize(params);
  if (first !== duplicate) fail("Claude user-input requests are not deduplicated by tool-use identity");
  const result = await first;
  if (calls !== 1 || request?.toolName !== "AskUserQuestion" || request?.toolCallId !== params.toolUseId) {
    fail("Claude user-input authorizer did not bridge the native tool identity");
  }
  if (result?.behavior !== "allow" || result.updatedInput?.answers?.["Which option?"] !== "Second") {
    fail("Claude user-input authorizer did not return the answered native input");
  }
};

const verifyCore = async (coreInput, contractState = "stock") => {
  const bridged = contractState === "bridged";
  const root = resolvePackageRoot(coreInput, "core");
  const packageJson = readJson(path.join(root, "package.json"));
  if (packageJson.name !== CORE_NAME || packageJson.version !== CORE_VERSION) {
    fail(`expected ${CORE_NAME}@${CORE_VERSION}, found ${packageJson.name}@${packageJson.version}`);
  }
  if (packageJson.engines?.node !== NODE_RANGE) fail(`unexpected Node engine range: ${packageJson.engines?.node}`);
  const questionExport = packageJson.exports?.["./plugin-sdk/question-gateway-runtime"];
  const questionRelative = typeof questionExport === "string" ? questionExport : questionExport?.default;
  if (typeof questionRelative !== "string" || !questionRelative) fail("question Gateway runtime export is missing");
  const buildInfo = readJson(path.join(root, "dist", "build-info.json"));
  if (buildInfo.version !== CORE_VERSION || buildInfo.commit !== CORE_COMMIT) {
    fail(`unexpected build identity ${buildInfo.version}@${buildInfo.commit}`);
  }
  const dist = resolveInside(root, "dist", "core dist directory");

  const askUser = findUniqueBundle(dist, "openclaw-tools-", [
    'name: "ask_user"',
    'gatewayCall("question.request"',
    'gatewayCall("question.waitAnswer"',
    "registerPendingAgentQuestion",
    "shouldIncludeAskUserToolForOpenClawTools",
  ], "native ask_user");
  const methodCatalog = findUniqueBundle(dist, "server-methods-list-", [
    "listCoreAdvertisedGatewayMethodNames", '"question.requested"', '"question.resolved"',
  ], "question RPC catalog");
  const methodScopes = findUniqueBundle(dist, "method-scopes-", [
    '"question.request"', '"question.waitAnswer"', '"question.resolve"',
    '"question.get"', '"question.list"', '"operator.questions"',
    "function listCoreAdvertisedGatewayMethodNames(",
  ], "question RPC scope");
  // 9.3 derives the advertised method list from the scope descriptors instead
  // of copying string literals into server-methods-list. Verify the actual
  // derived catalog and the event list, not obsolete source duplication.
  const scopeContract = await importFresh(methodScopes);
  const catalogContract = await importFresh(methodCatalog);
  if (typeof scopeContract.f !== "function" || !Array.isArray(catalogContract.t)) {
    fail("question method/event catalog exports drifted");
  }
  const advertised = scopeContract.f();
  if (!Array.isArray(advertised) || ["question.request", "question.waitAnswer", "question.resolve", "question.get", "question.list"]
    .some((method) => !advertised.includes(method))
    || ["question.requested", "question.resolved"].some((event) => !catalogContract.t.includes(event))) {
    fail("question method/event catalog omitted required capabilities");
  }
  findUniqueBundle(dist, "chat-send-handler-", [
    "queueModeOverride: p.queueMode",
    'p.queueMode === "steer"',
    'messageInjectionDisposition: "rejected"',
    "resolveCurrentMessageInjectionTarget",
  ], "chat.send steer");
  const claude = findUniqueBundle(dist, "cli-user-input-", [
    "function createClaudeCliUserInputAuthorizer(context)",
    'toolName: "AskUserQuestion"',
    "context.requestUserInput",
    'behavior: "allow"',
    "updatedInput",
  ], "Claude request_user_input");
  const runs = findUniqueBundle(dist, "runs-", [
    "function queueEmbeddedAgentMessageWithOutcomeAsync(",
    "function setActiveEmbeddedRun(",
    "ACTIVE_EMBEDDED_RUNS_BY_RUN_ID",
  ], "active-runs");
  const watchdog = findUniqueBundle(dist, "cli-watchdog-defaults-", [
    "CLI_FRESH_WATCHDOG_DEFAULTS",
    "CLI_RESUME_WATCHDOG_DEFAULTS",
    "CLI_WATCHDOG_MIN_TIMEOUT_MS",
  ], "stock CLI-watchdog defaults");
  const deleteSchema = findUniqueBundle(dist, "src-", [
    "//#region packages/gateway-protocol/src/schema/sessions-delete.ts",
    "const SessionsDeleteParamsSchema = closedObject({",
    "expectedSessionUpdatedAt: Type.Optional(Type.Number({ minimum: 0 }))",
  ], "session-delete protocol schema");
  const deleteHandler = findUniqueBundle(dist, "sessions-delete-", [
    "const sessionDeleteHandlers = { \"sessions.delete\"",
    "deleteSessionEntryLifecycle(deletionParams)",
    "deleteTranscriptWithoutArchive: incognito",
  ], "session-delete handler");
  const runsBackup = `${runs}${RUNS_BACKUP_SUFFIX}`;
  const deleteSchemaBackup = `${deleteSchema}${HARD_DELETE_BACKUP_SUFFIX}`;
  const deleteHandlerBackup = `${deleteHandler}${HARD_DELETE_BACKUP_SUFFIX}`;
  const retainedBaseline = retainedBridgeBaseline(root, [
    ["activeRuns", runs, RUNS_STOCK_SHA256, RUNS_BRIDGED_SHA256, RUNS_BACKUP_SUFFIX],
    ["deleteSchema", deleteSchema, DELETE_SCHEMA_STOCK_SHA256, DELETE_SCHEMA_BRIDGED_SHA256, HARD_DELETE_BACKUP_SUFFIX],
    ["deleteHandler", deleteHandler, DELETE_HANDLER_STOCK_SHA256, DELETE_HANDLER_BRIDGED_SHA256, HARD_DELETE_BACKUP_SUFFIX],
  ]);
  assertPackageTargetMetadata(runs, "active-runs bundle");
  assertPackageTargetMetadata(deleteSchema, "session-delete protocol schema");
  assertPackageTargetMetadata(deleteHandler, "session-delete handler");
  assertExactFileHash(runs, RUNS_STOCK_SHA256, "stock native active-runs bundle");
  assertExactFileHash(watchdog, WATCHDOG_STOCK_SHA256, "stock CLI-watchdog defaults");
  if (fs.existsSync(`${watchdog}.bridgesllm-claude-ask-user-route-v2.bak`)) {
    fail("9.1 stock CLI-watchdog retains a retired Portal rollback backup");
  }
  if (bridged) {
    assertNoLegacyMutationResidue(root, new Set([
      path.resolve(runs),
      path.resolve(deleteSchema),
      path.resolve(deleteHandler),
      path.resolve(runsBackup),
      path.resolve(deleteSchemaBackup),
      path.resolve(deleteHandlerBackup),
    ]));
    const deleteSchemaText = assertExactFileHash(
      deleteSchema,
      DELETE_SCHEMA_BRIDGED_SHA256,
      "bridged session-delete protocol schema",
    ).toString("utf8");
    const deleteHandlerText = assertExactFileHash(
      deleteHandler,
      DELETE_HANDLER_BRIDGED_SHA256,
      "bridged session-delete handler",
    ).toString("utf8");
    if (deleteSchemaText.split(HARD_DELETE_MARKER).length !== 2
      || deleteSchemaText.split("deleteTranscriptWithoutArchive: Type.Optional(Type.Boolean())").length !== 2
      || deleteHandlerText.split(HARD_DELETE_MARKER).length !== 2
      || deleteHandlerText.split("const deleteTranscriptWithoutArchive = p.deleteTranscriptWithoutArchive === true;").length !== 2
      || deleteHandlerText.split("archiveTranscript: incognito || deleteTranscriptWithoutArchive ? false : deleteTranscript,").length !== 2
      || deleteHandlerText.split("deleteTranscriptWithoutArchive: incognito || deleteTranscriptWithoutArchive,").length !== 2) {
      fail("bridged hard-delete Gateway contract drifted");
    }
    const backupStates = [
      runsBackup,
      deleteSchemaBackup,
      deleteHandlerBackup,
    ].map((filename) => fs.existsSync(filename));
    if (!backupStates.every((present) => present === backupStates[0])) {
      fail("Portal bridge rollback backups are only partially present");
    }
    if (backupStates[0]) {
      assertRollbackBackup(runs, RUNS_BACKUP_SUFFIX, RUNS_STOCK_SHA256, "native active-runs");
      assertRollbackBackup(deleteSchema, HARD_DELETE_BACKUP_SUFFIX, retainedBaseline ? DELETE_SCHEMA_BRIDGED_SHA256 : DELETE_SCHEMA_STOCK_SHA256, "session-delete protocol schema");
      assertRollbackBackup(deleteHandler, HARD_DELETE_BACKUP_SUFFIX, retainedBaseline ? DELETE_HANDLER_BRIDGED_SHA256 : DELETE_HANDLER_STOCK_SHA256, "session-delete handler");
    }
  } else if (contractState === "stock") {
    if (retainedBaseline) fail("stock contract cannot retain a bridged baseline journal");
    assertNoLegacyMutationResidue(root);
    assertExactFileHash(deleteSchema, DELETE_SCHEMA_STOCK_SHA256, "stock session-delete protocol schema");
    assertExactFileHash(deleteHandler, DELETE_HANDLER_STOCK_SHA256, "stock session-delete handler");
    if ([runsBackup, deleteSchemaBackup, deleteHandlerBackup].some((filename) => fs.existsSync(filename))) {
      fail("stock contract retains a Portal rollback backup");
    }
  } else {
    const targets = [
      [runs, runsBackup, RUNS_STOCK_SHA256, RUNS_BRIDGED_SHA256, RUNS_BACKUP_SUFFIX, "native active-runs"],
      [deleteSchema, deleteSchemaBackup, DELETE_SCHEMA_STOCK_SHA256, DELETE_SCHEMA_BRIDGED_SHA256, HARD_DELETE_BACKUP_SUFFIX, "session-delete protocol schema"],
      [deleteHandler, deleteHandlerBackup, DELETE_HANDLER_STOCK_SHA256, DELETE_HANDLER_BRIDGED_SHA256, HARD_DELETE_BACKUP_SUFFIX, "session-delete handler"],
    ];
    assertNoLegacyMutationResidue(root, new Set(targets.flatMap(([target, backup]) => [path.resolve(target), path.resolve(backup)])));
    for (const [target, backup, stockHash, bridgedHash, suffix, label] of targets) {
      const observed = sha256(readRegularFile(target));
      if (observed !== stockHash && observed !== bridgedHash) {
        fail(`${label} hash is neither attested stock nor bridged content: ${observed}`);
      }
      if (retainedBaseline && observed !== bridgedHash) fail("retained bridge target drifted");
      if (fs.existsSync(backup)) assertRollbackBackup(target, suffix, retainedBaseline ? bridgedHash : stockHash, label);
    }
  }
  const questionRuntime = resolveInside(root, questionRelative, "question Gateway runtime module");
  for (const filename of [askUser, claude, runs, watchdog, deleteSchema, deleteHandler, questionRuntime]) assertSyntax(filename);
  await assertQuestionRuntimeBehavior(questionRuntime);
  await assertClaudeBehavior(claude);
  return { root, askUser, claude, runs, deleteSchema, deleteHandler };
};

const verifyCodex = async (codexInput) => {
  const root = resolvePackageRoot(codexInput, "Codex plugin");
  const packageJson = readJson(path.join(root, "package.json"));
  if (packageJson.name !== CODEX_NAME || packageJson.version !== CODEX_VERSION) {
    fail(`expected ${CODEX_NAME}@${CODEX_VERSION}, found ${packageJson.name}@${packageJson.version}`);
  }
  if (packageJson.peerDependencies?.openclaw !== ">=2026.9.3") {
    fail(`unexpected Codex OpenClaw peer contract: ${packageJson.peerDependencies?.openclaw}`);
  }
  const dist = resolveInside(root, "dist", "Codex dist directory");
  assertNoLegacyMutationResidue(root);
  const runAttempt = findUniqueBundle(dist, "run-attempt-", [
    "function createCodexUserInputBridge(params)",
    'requestParams.threadId !== params.threadId || requestParams.turnId !== params.turnId',
    'request.method === "item/tool/requestUserInput"',
    "userInputBridgeRef.current?.handleRequest",
    "claimPendingAgentQuestionAnswer",
    'params.client.request("turn/steer"',
  ], "Codex request_user_input bridge");
  assertSyntax(runAttempt);
  return { root, runAttempt };
};

const main = async () => {
  const [mode, coreInput, codexInput, ...extra] = process.argv.slice(2);
  if (process.env.PORTAL_EXPECTED_OPENCLAW_CORE_COMMIT
    && process.env.PORTAL_EXPECTED_OPENCLAW_CORE_COMMIT !== CORE_COMMIT) {
    fail("installer and stock verifier disagree on the tested OpenClaw commit");
  }
  const modes = ["core", "pair", "commit-targets", "targets", "bridged-core", "bridged-pair", "bridged-targets"];
  if (extra.length || !modes.includes(mode)) {
    fail("usage: verifier <core|pair|commit-targets|targets|bridged-core|bridged-pair|bridged-targets> <core-package-dir> [codex-package-dir]");
  }
  const bridged = mode.startsWith("bridged-");
  const core = await verifyCore(coreInput, mode === "targets" ? "mixed" : bridged ? "bridged" : "stock");
  if (mode === "pair" || mode === "bridged-pair") await verifyCodex(codexInput);
  if (mode === "commit-targets" || mode === "targets" || mode === "bridged-targets") {
    process.stdout.write(`${core.runs}\n${core.deleteSchema}\n${core.deleteHandler}\n`);
  } else {
    process.stderr.write(`verified ${bridged ? "Portal-bridged" : "stock"} OpenClaw ${CORE_VERSION}${mode.endsWith("pair") ? " + @openclaw/codex" : ""} contracts\n`);
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
