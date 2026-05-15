#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_ARTIFACT_DIR = ".artifacts/gateway-profile";
const DEFAULT_LOG_FILE = "gateway-profile.log";

const resolveArtifactDir = () => {
  const configured =
    process.env.OPENCLAW_GATEWAY_PROFILE_DIR?.trim() ||
    process.env.OPENCLAW_RUN_NODE_CPU_PROF_DIR?.trim() ||
    DEFAULT_ARTIFACT_DIR;
  return path.resolve(process.cwd(), configured);
};

const artifactDir = resolveArtifactDir();
const outputLogPath = path.join(artifactDir, DEFAULT_LOG_FILE);
fs.mkdirSync(artifactDir, { recursive: true });

const env = {
  ...process.env,
  OPENCLAW_DEBUG_INGRESS_TIMING: process.env.OPENCLAW_DEBUG_INGRESS_TIMING ?? "1",
  OPENCLAW_DEBUG_MODEL_TRANSPORT: process.env.OPENCLAW_DEBUG_MODEL_TRANSPORT ?? "1",
  OPENCLAW_RUN_NODE_CPU_PROF_DIR:
    process.env.OPENCLAW_RUN_NODE_CPU_PROF_DIR ?? artifactDir,
  OPENCLAW_RUN_NODE_OUTPUT_LOG:
    process.env.OPENCLAW_RUN_NODE_OUTPUT_LOG ?? outputLogPath,
};

process.stderr.write(`[openclaw] gateway profile artifacts: ${artifactDir}\n`);
process.stderr.write(`[openclaw] gateway profile output log: ${env.OPENCLAW_RUN_NODE_OUTPUT_LOG}\n`);

const child = spawn(
  process.execPath,
  ["scripts/watch-node.mjs", "gateway", "run", "--force", ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  },
);

const forwardSignal = (signal) => {
  try {
    child.kill(signal);
  } catch {
    // Best-effort only.
  }
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
