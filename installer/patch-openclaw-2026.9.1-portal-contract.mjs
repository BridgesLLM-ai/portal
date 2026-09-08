#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PACKAGE_VERSION = "2026.9.1";
// OpenClaw 9.1 ships the steering behavior Portal previously had to inject.
// Keep the exact native bundle as an identity-only transaction member so the
// established three-member rollback/commit topology remains stable.
const RUNS_STOCK = "407999737bf83f799b68042ab6e9de48920bcdf656be8fba58c3183a82f24359";
const RUNS_PATCHED = RUNS_STOCK;
const RUNS_BACKUP_SUFFIX = ".bridgesllm-pending-input-v1.bak";
const DELETE_SCHEMA_STOCK = "c3a060a7deb79384ec1294f6e551cb21c3e3c423ab9ac19ea1985a08334c41a0";
const DELETE_SCHEMA_PATCHED = "3d1bcd9a9343e3ea3193998f1cb4863470e3dbd19c6d5a89282ff78d9e585cc4";
const DELETE_HANDLER_STOCK = "7f60601501c1fe5e018e84c7ef1de2b4522b09f46eaaec98a7076356cde9a352";
const DELETE_HANDLER_PATCHED = "58b1845f613261c0451cdbb1ff26c8b9e8f58f96d493183f82920a7cb51dc536";
const HARD_DELETE_BACKUP_SUFFIX = ".bridgesllm-hard-delete-v1.bak";
const TRANSACTION_SCHEMA = "bridgesllm-openclaw-2026.9.1-portal-bridge-transaction-v1";
const TRANSACTION_NAME = ".bridgesllm-portal-bridge-transaction-v1.json";
const HARD_DELETE_MARKER = "bridgesllm-openclaw-hard-delete-transcript-2026.9.1-v1";
const TARGET_MODE = 0o644;

const fail = (message) => {
  throw new Error(`OpenClaw ${PACKAGE_VERSION} Portal-contract patch failed: ${message}`);
};
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const occurrences = (text, needle) => text.split(needle).length - 1;
const exists = (filename) => {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const checkpoint = (name, packageRoot) => {
  if (process.env.PORTAL_OPENCLAW_TRANSACTION_TEST_ROOT !== packageRoot) return;
  if (process.env.PORTAL_OPENCLAW_TRANSACTION_FAIL_AT === name) {
    fail(`injected transaction failure at ${name}`);
  }
  if (process.env.PORTAL_OPENCLAW_TRANSACTION_KILL_AT === name) {
    process.kill(process.pid, "SIGKILL");
  }
};

const inspectRegular = (filename, label) => {
  let metadata;
  try {
    metadata = fs.lstatSync(filename);
  } catch (error) {
    fail(`could not inspect ${label} at ${filename}: ${error.message}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    fail(`${label} is not one regular, non-linked file: ${filename}`);
  }
  if (process.getuid?.() === 0 && (metadata.uid !== 0 || metadata.gid !== 0)) {
    fail(`${label} is not root-owned by root:root: ${filename}`);
  }
  return metadata;
};

const inspectTarget = (filename, label) => {
  const metadata = inspectRegular(filename, label);
  if ((metadata.mode & 0o777) !== TARGET_MODE) {
    fail(`${label} is not mode ${TARGET_MODE.toString(8)}: ${filename}`);
  }
  return metadata;
};

const readRegular = (filename, label) => {
  inspectRegular(filename, label);
  try {
    return fs.readFileSync(filename);
  } catch (error) {
    fail(`could not read ${label} at ${filename}: ${error.message}`);
  }
};

const fsyncDirectory = (directory) => {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

const writeAtomic = (filename, content, metadata) => {
  const directory = path.dirname(filename);
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.bridgesllm-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", metadata.mode & 0o777);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, metadata.mode & 0o777);
    if (process.getuid?.() === 0) fs.fchownSync(fd, metadata.uid, metadata.gid);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filename);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
    fail(`could not atomically write ${filename}: ${error.message}`);
  }
};

const unlinkDurable = (filename) => {
  fs.unlinkSync(filename);
  fsyncDirectory(path.dirname(filename));
};

const createOrVerifyBackup = (item, stock, created) => {
  const backup = `${item.filename}${item.suffix}`;
  if (exists(backup)) {
    if (sha256(readRegular(backup, "rollback backup")) !== item.stockHash) {
      fail(`rollback backup is not the attested stock file: ${backup}`);
    }
    return;
  }
  const directory = path.dirname(backup);
  const temporary = path.join(
    directory,
    `.${path.basename(backup)}.bridgesllm-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, stock);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    if (process.getuid?.() === 0) fs.fchownSync(fd, 0, 0);
    fs.closeSync(fd);
    fd = undefined;
    if (exists(backup)) fail(`rollback backup appeared during publication: ${backup}`);
    fs.renameSync(temporary, backup);
    fsyncDirectory(directory);
    created.push(backup);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
    fail(`could not create rollback backup ${backup}: ${error.message}`);
  }
};

const expectedJournal = (packageRoot, items) => ({
  schema: TRANSACTION_SCHEMA,
  packageRoot,
  targets: items.map((item) => ({
    id: item.id,
    path: item.filename,
    stockSha256: item.stockHash,
    patchedSha256: item.patchedHash,
    backupPath: `${item.filename}${item.suffix}`,
    backupSha256: item.stockHash,
  })),
});

const canonicalJson = (value) => `${JSON.stringify(value)}\n`;

const readAndValidateJournal = (filename, expected) => {
  const metadata = inspectRegular(filename, "Portal bridge transaction journal");
  if ((metadata.mode & 0o777) !== 0o600) fail(`transaction journal is not mode 0600: ${filename}`);
  let raw;
  let value;
  try {
    raw = fs.readFileSync(filename, "utf8");
    value = JSON.parse(raw);
  } catch (error) {
    fail(`transaction journal is unreadable or malformed: ${error.message}`);
  }
  if (raw !== canonicalJson(value) || canonicalJson(value) !== canonicalJson(expected)) {
    fail("transaction journal does not bind the exact native-steer and hard-delete targets");
  }
};

const inspectGroup = (items) => items.map((item) => {
  const metadata = inspectTarget(item.filename, "Portal-contract target");
  const content = readRegular(item.filename, "Portal-contract target");
  const targetHash = sha256(content);
  if (targetHash !== item.stockHash && targetHash !== item.patchedHash) {
    fail(`target hash is neither attested stock nor patched content: ${item.filename} (${targetHash})`);
  }
  const backup = `${item.filename}${item.suffix}`;
  let backupPresent = false;
  if (exists(backup)) {
    const metadata = inspectRegular(backup, "rollback backup");
    if ((metadata.mode & 0o777) !== 0o600 || sha256(readRegular(backup, "rollback backup")) !== item.stockHash) {
      fail(`rollback backup is not the mode-0600 attested stock file: ${backup}`);
    }
    backupPresent = true;
  }
  return {
    ...item,
    content,
    metadata,
    targetHash,
    backup,
    backupPresent,
  };
});

const reconcileUncommitted = (packageRoot, items, journal) => {
  const inspected = inspectGroup(items);
  const journalPresent = exists(journal);
  const backupPresent = inspected.some((item) => item.backupPresent);
  const allPatched = inspected.every((item) => item.targetHash === item.patchedHash);
  const allStock = inspected.every((item) => item.targetHash === item.stockHash);

  if (!journalPresent && !backupPresent) {
    if (allStock) return "stock";
    if (allPatched) return "committed";
    fail("mixed stock/bridged targets have no complete recovery transaction");
  }
  if (journalPresent) readAndValidateJournal(journal, expectedJournal(packageRoot, items));
  for (const item of inspected) {
    if (item.targetHash === item.patchedHash && !item.backupPresent) {
      fail(`patched target is missing its bound stock backup: ${item.filename}`);
    }
  }

  // There is no fsynced tested-pair commit decision in this helper. Any
  // surviving preparation journal therefore owns an uncommitted generation:
  // converge every target to stock before a fresh three-target application.
  for (const item of [...inspected].reverse()) {
    if (item.targetHash !== item.patchedHash) continue;
    // Backups are deliberately private mode 0600. Renaming one over the live
    // npm bundle would silently turn a stock 0644 package member into 0600 and
    // make a crash rollback observably different from the published package.
    // Copy the attested bytes through the atomic writer so the live target
    // keeps its exact package metadata; the still-present backup remains the
    // recovery authority until the stock target is independently verified.
    writeAtomic(
      item.filename,
      readRegular(item.backup, "rollback backup"),
      item.metadata,
    );
    checkpoint(`rollback-${item.id}`, packageRoot);
    if ((inspectTarget(item.filename, "rolled-back target").mode & 0o777) !== TARGET_MODE
      || sha256(readRegular(item.filename, "rolled-back target")) !== item.stockHash) {
      fail(`rollback did not restore attested stock bytes: ${item.filename}`);
    }
  }
  const rolledBack = inspectGroup(items);
  if (!rolledBack.every((item) => item.targetHash === item.stockHash)) {
    fail("uncommitted Portal bridge did not converge to all-stock bytes");
  }
  for (const item of rolledBack) {
    if (!item.backupPresent) continue;
    unlinkDurable(item.backup);
    checkpoint(`cleanup-${item.id}`, packageRoot);
  }
  if (journalPresent) {
    unlinkDurable(journal);
    checkpoint("cleanup-journal", packageRoot);
  }
  return "stock";
};

const findUnique = (dist, prefix, markers, label) => {
  const matches = fs.readdirSync(dist)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".js"))
    .map((name) => path.join(dist, name))
    .filter((filename) => {
      const text = readRegular(filename, `${label} candidate`).toString("utf8");
      return markers.every((marker) => text.includes(marker));
    });
  if (matches.length !== 1) fail(`expected exactly one ${label} bundle, found ${matches.length}`);
  return matches[0];
};

const assertSyntax = (filename) => {
  const result = spawnSync(process.execPath, ["--check", filename], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    fail(`JavaScript syntax check failed for ${filename}: ${(result.stderr || result.stdout).trim()}`);
  }
};

const attestNativeRuns = (stock) => Buffer.from(stock);

const patchDeleteSchema = (stock) => {
  let text = stock.toString("utf8");
  const anchor = "\tdeleteTranscript: Type.Optional(Type.Boolean()),";
  if (occurrences(text, anchor) !== 1) fail("hard-delete schema anchor count was not one");
  if (occurrences(text, HARD_DELETE_MARKER) !== 0
    || occurrences(text, "deleteTranscriptWithoutArchive: Type.Optional(Type.Boolean())") !== 0) {
    fail("stock hard-delete schema already contains a partial Portal contract");
  }
  text = text.replace(anchor, [
    anchor,
    `\t// ${HARD_DELETE_MARKER}`,
    "\tdeleteTranscriptWithoutArchive: Type.Optional(Type.Boolean()),",
  ].join("\n"));
  return Buffer.from(text);
};

const patchDeleteHandler = (stock) => {
  let text = stock.toString("utf8");
  const declaration = "\tconst deleteTranscript = typeof p.deleteTranscript === \"boolean\" ? p.deleteTranscript : true;";
  const archive = "\t\t\tarchiveTranscript: incognito ? false : deleteTranscript,";
  const hardDelete = "\t\t\tdeleteTranscriptWithoutArchive: incognito,";
  for (const marker of [declaration, archive, hardDelete]) {
    if (occurrences(text, marker) !== 1) fail(`hard-delete handler anchor count was not one: ${marker}`);
  }
  if (occurrences(text, HARD_DELETE_MARKER) !== 0
    || occurrences(text, "const deleteTranscriptWithoutArchive = p.deleteTranscriptWithoutArchive === true;") !== 0) {
    fail("stock hard-delete handler already contains a partial Portal contract");
  }
  text = text.replace(declaration, [
    `\t// ${HARD_DELETE_MARKER}`,
    declaration,
    "\tconst deleteTranscriptWithoutArchive = p.deleteTranscriptWithoutArchive === true;",
    "\tif (deleteTranscriptWithoutArchive && (p.deleteTranscript === true || !p.expectedSessionId?.trim() || p.expectedSessionUpdatedAt === void 0)) {",
    "\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, \"Hard transcript deletion requires exact session guards and cannot also archive the transcript.\"));",
    "\t\treturn;",
    "\t}",
  ].join("\n"));
  text = text.replace(
    archive,
    "\t\t\tarchiveTranscript: incognito || deleteTranscriptWithoutArchive ? false : deleteTranscript,",
  );
  text = text.replace(
    hardDelete,
    "\t\t\tdeleteTranscriptWithoutArchive: incognito || deleteTranscriptWithoutArchive,",
  );
  return Buffer.from(text);
};

const main = () => {
  if (process.getuid?.() !== 0) fail("patcher must run as root");
  if (process.argv.length !== 3) fail("usage: patcher <openclaw-dist>");
  const dist = fs.realpathSync(process.argv[2]);
  if (!fs.lstatSync(dist).isDirectory()) fail(`dist path is not a directory: ${dist}`);

  const packageRoot = fs.realpathSync(path.join(dist, ".."));
  const packageJson = JSON.parse(readRegular(path.join(packageRoot, "package.json"), "package metadata"));
  if (packageJson.name !== "openclaw" || packageJson.version !== PACKAGE_VERSION) {
    fail(`refusing ${packageJson.name}@${packageJson.version}; expected openclaw@${PACKAGE_VERSION}`);
  }

  const items = [
    {
      id: "activeRuns",
      filename: findUnique(dist, "runs-", [
        "function queueEmbeddedAgentMessageWithOutcomeAsync(",
        "function setActiveEmbeddedRun(",
        "ACTIVE_EMBEDDED_RUNS_BY_RUN_ID",
      ], "native active-runs"),
      suffix: RUNS_BACKUP_SUFFIX,
      stockHash: RUNS_STOCK,
      patchedHash: RUNS_PATCHED,
      patch: attestNativeRuns,
    },
    {
      id: "deleteSchema",
      filename: findUnique(dist, "src-", [
        "//#region packages/gateway-protocol/src/schema/sessions-delete.ts",
        "const SessionsDeleteParamsSchema = closedObject({",
        "expectedSessionUpdatedAt: Type.Optional(Type.Number({ minimum: 0 }))",
      ], "session-delete protocol schema"),
      suffix: HARD_DELETE_BACKUP_SUFFIX,
      stockHash: DELETE_SCHEMA_STOCK,
      patchedHash: DELETE_SCHEMA_PATCHED,
      patch: patchDeleteSchema,
    },
    {
      id: "deleteHandler",
      filename: findUnique(dist, "sessions-delete-", [
        "const sessionDeleteHandlers = { \"sessions.delete\"",
        "deleteSessionEntryLifecycle(deletionParams)",
        "deleteTranscriptWithoutArchive: incognito",
      ], "session-delete handler"),
      suffix: HARD_DELETE_BACKUP_SUFFIX,
      stockHash: DELETE_HANDLER_STOCK,
      patchedHash: DELETE_HANDLER_PATCHED,
      patch: patchDeleteHandler,
    },
  ];
  const journal = path.join(packageRoot, TRANSACTION_NAME);
  const originals = new Map();
  const createdBackups = [];
  try {
    const reconciliation = reconcileUncommitted(packageRoot, items, journal);
    if (reconciliation === "committed") {
      process.stdout.write(`${items.map((item) => item.filename).join("\n")}\n`);
      return;
    }
    for (const item of inspectGroup(items)) {
      originals.set(item.filename, { content: item.content, metadata: item.metadata });
    }

    for (const item of items) {
      const original = originals.get(item.filename);
      const stock = original.content;
      if (sha256(stock) !== item.stockHash) fail(`rollback source drifted: ${item.filename}`);
      createOrVerifyBackup(item, stock, createdBackups);
      checkpoint(`backup-${item.id}`, packageRoot);
    }
    writeAtomic(journal, Buffer.from(canonicalJson(expectedJournal(packageRoot, items))), {
      mode: 0o600,
      uid: 0,
      gid: 0,
    });
    checkpoint("journal", packageRoot);
    for (const item of items) {
      const original = originals.get(item.filename);
      const stock = original.content;
      const patched = item.patch(stock);
      if (sha256(patched) !== item.patchedHash) {
        fail(`generated patch hash drifted for ${item.filename}: ${sha256(patched)}`);
      }
      if (sha256(original.content) !== item.patchedHash) writeAtomic(item.filename, patched, original.metadata);
      checkpoint(`target-${item.id}`, packageRoot);
      assertSyntax(item.filename);
      if (sha256(readRegular(item.filename, "patched target")) !== item.patchedHash) {
        fail(`post-write verification failed: ${item.filename}`);
      }
    }
    checkpoint("verified", packageRoot);
  } catch (error) {
    // Normal failures are repaired eagerly; SIGKILL/power loss is handled by
    // the same journal-driven reconciliation on the next installer run.
    try { reconcileUncommitted(packageRoot, items, journal); } catch {}
    throw error;
  }

  process.stdout.write(`${items.map((item) => item.filename).join("\n")}\n`);
};

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
