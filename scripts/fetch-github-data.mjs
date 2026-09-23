import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { evaluateSnapshot } from "../site/snapshot-policy.js";

const now = new Date();
const eventName = process.env.GITHUB_EVENT_NAME || "local";
function easternParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
}
const eastern = easternParts(now);
const easternHour = Number(eastern.hour);
const easternDate = `${eastern.year}-${eastern.month}-${eastern.day}`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? 1}`)));
  });
}

async function fetchDeployedSnapshot() {
  const response = await fetch(`https://brendan-afg.github.io/afg-command-center-live/data.json?ts=${Date.now()}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Unable to inspect deployed snapshot (HTTP ${response.status})`);
  const snapshot = await response.json();
  if (
    snapshot?.schemaVersion !== 2 ||
    !snapshot?.generatedAt ||
    snapshot?.access?.mode !== "link_only_no_login" ||
    snapshot?.manifest?.sourceMode !== "authenticated_service_account_drive_api" ||
    !/^[a-f0-9]{40}$/.test(snapshot?.manifest?.sourceCommit || "") ||
    snapshot?.source?.connection !== "fresh_snapshot" ||
    snapshot?.source?.scannedFolders !== snapshot?.source?.totalFolders ||
    evaluateSnapshot(snapshot).locked
  ) {
    throw new Error("Deployed snapshot failed public-snapshot validation");
  }
  return snapshot;
}

let deployedSnapshot = null;
if (eventName === "schedule") deployedSnapshot = await fetchDeployedSnapshot();
const deployedParts = deployedSnapshot?.generatedAt ? easternParts(new Date(deployedSnapshot.generatedAt)) : null;
const deployedEasternDate = deployedParts ? `${deployedParts.year}-${deployedParts.month}-${deployedParts.day}` : null;
const scheduledRefreshRequired = eventName === "schedule" && easternHour >= 5 && deployedEasternDate !== easternDate;
const shouldRefresh = eventName !== "schedule" || scheduledRefreshRequired;

if (shouldRefresh) {
  console.log(`Running authenticated AFG Drive refresh (${eventName}, ${String(easternHour).padStart(2, "0")}:00 America/New_York; deployed date ${deployedEasternDate || "none"}).`);
  await run("pnpm", ["exec", "tsx", "scripts/generate-dashboard.ts"]);
} else {
  console.log(`Current Eastern business date is already deployed, or the 5 a.m. window has not opened; preserving link-only snapshot (${String(easternHour).padStart(2, "0")}:00 America/New_York).`);
  await fs.writeFile("site/data.json", JSON.stringify(deployedSnapshot));
}
