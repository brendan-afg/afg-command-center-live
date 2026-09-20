export function easternParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
}

export function evaluateSnapshot(data, now = new Date()) {
  const reasons = [];
  const generated = new Date(data?.generatedAt);
  const ageHours = Number.isFinite(generated.getTime()) ? (now.getTime() - generated.getTime()) / 3_600_000 : Number.POSITIVE_INFINITY;
  const parts = easternParts(now);
  const generatedParts = Number.isFinite(generated.getTime()) ? easternParts(generated) : null;
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const afterTarget = Number(parts.hour) >= 5;
  if (!Number.isFinite(generated.getTime())) reasons.push("Snapshot timestamp is invalid");
  if (Number.isFinite(ageHours) && ageHours < -(5 / 60)) reasons.push("Snapshot timestamp is materially in the future");
  if (ageHours > 20) reasons.push("Snapshot is older than the 20-hour safety limit");
  if (afterTarget && data?.businessDateEastern !== today) reasons.push("No validated snapshot exists for the current Eastern business date after 5:00 a.m.");
  if (afterTarget && data?.businessDateEastern === today && generatedParts && Number(generatedParts.hour) < 5) reasons.push("No post-5:00 a.m. Eastern snapshot exists for the current business date");
  if (data?.manifest?.sourceMode !== "authenticated_service_account_drive_api") reasons.push("Production source is not the authenticated Drive API");
  if (data?.manifest?.internalValidation !== "passed") reasons.push("Snapshot manifest validation did not pass");
  if (data?.source?.connection !== "fresh_snapshot" || data?.source?.failedFolderCount > 0 || data?.source?.evidenceReadErrorCount > 0) reasons.push("Drive collection is not a fresh, error-free snapshot");
  if (!Number.isInteger(data?.source?.totalFolders) || data.source.totalFolders <= 0 || data?.source?.scannedFolders !== data?.source?.totalFolders) reasons.push("Drive folder coverage does not reconcile within the returned authenticated scope");
  if (!data?.manifest?.runId || data?.manifest?.snapshotId !== data?.source?.snapshotId) reasons.push("Deployment manifest and snapshot identifiers do not reconcile");
  if (!/^[0-9a-f]{40}$/i.test(String(data?.manifest?.sourceCommit || ""))) reasons.push("Snapshot is not bound to a verified source commit");
  return { locked: reasons.length > 0, reasons, ageHours: Number.isFinite(ageHours) ? ageHours : null };
}
