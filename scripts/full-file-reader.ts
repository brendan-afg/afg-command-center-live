import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { getDriveAccessToken, type DriveDealSnapshot, type DriveFileRecord } from "../server/driveSync";

const execFile = promisify(execFileCallback);
const GOOGLE_FOLDER = "application/vnd.google-apps.folder";
const GOOGLE_SHORTCUT = "application/vnd.google-apps.shortcut";
const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_PER_FILE = 30_000;
const MAX_TEXT_PER_DEAL = 120_000;
const REQUEST_TIMEOUT_MS = 45_000;
const EXTRACTION_CACHE_DIR = "/home/ubuntu/afg-file-extraction-cache";

export type ReadMethod = "text" | "google_export" | "pdf" | "office_xml" | "libreoffice" | "ocr" | "unsupported" | "too_large" | "failed";
export type ReadStatus = "read" | "partial" | "empty" | "unsupported" | "too_large" | "failed";
export type ReadDocument = {
  fileId: string;
  fileName: string;
  mimeType: string;
  modifiedTime: string;
  size: number | null;
  method: ReadMethod;
  status: ReadStatus;
  originalCharacters: number;
  retainedCharacters: number;
  truncated: boolean;
  characters: number;
  text: string;
  note: string | null;
};
export type DealReadBundle = {
  dealId: string;
  folderName: string;
  inventoryCount: number;
  readableCount: number;
  partialCount: number;
  emptyCount: number;
  unsupportedCount: number;
  tooLargeCount: number;
  failedCount: number;
  extractedCharacters: number;
  contentHash: string;
  documents: ReadDocument[];
};
export type FullReadResult = {
  generatedAt: string;
  folderCount: number;
  inventoryCount: number;
  readableCount: number;
  partialCount: number;
  emptyCount: number;
  unsupportedCount: number;
  tooLargeCount: number;
  failedCount: number;
  deals: DealReadBundle[];
};

type DriveFile = DriveFileRecord & { parents?: string[]; shortcutDetails?: { targetId?: string; targetMimeType?: string } };

export function prepareExtractedText(value: string) {
  const normalized = value.replace(/\0/g, "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  const text = normalized.slice(0, MAX_TEXT_PER_FILE);
  return {
    text,
    originalCharacters: normalized.length,
    retainedCharacters: text.length,
    truncated: normalized.length > text.length,
    status: normalized.length === 0 ? "empty" as const : normalized.length > text.length ? "partial" as const : "read" as const,
  };
}

async function driveFetch(url: string, init: RequestInit = {}) {
  const token = await getDriveAccessToken();
  const response = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Drive HTTP ${response.status}`);
  return response;
}

async function listChildren(parentId: string) {
  const files: DriveFile[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size,parents,shortcutDetails(targetId,targetMimeType))",
      pageSize: "1000",
      orderBy: "modifiedTime desc",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    const payload = await response.json() as { files?: DriveFile[]; nextPageToken?: string };
    files.push(...(payload.files || []));
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return files;
}

async function listTree(folderId: string) {
  const files: DriveFile[] = [];
  const visited = new Set([folderId]);
  let frontier = [folderId];
  while (frontier.length) {
    const current = frontier.splice(0, 4);
    const levels = await Promise.all(current.map(listChildren));
    for (const children of levels) {
      for (const file of children) {
        files.push(file);
        if (file.mimeType === GOOGLE_FOLDER && !visited.has(file.id)) {
          visited.add(file.id);
          frontier.push(file.id);
        }
      }
    }
  }
  return files.filter(file => file.mimeType !== GOOGLE_FOLDER);
}

async function downloadBytes(file: DriveFile, exportMime?: string) {
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`;
  const url = exportMime ? `${base}/export?mimeType=${encodeURIComponent(exportMime)}` : `${base}?alt=media&supportsAllDrives=true`;
  const response = await driveFetch(url);
  return Buffer.from(await response.arrayBuffer());
}

async function commandText(command: string, args: string[]) {
  const { stdout } = await execFile(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 90_000 });
  return String(stdout || "");
}

function xmlToText(xml: string) {
  return xml
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<w:br\s*\/>|<a:br\s*\/>/g, "\n")
    .replace(/<\/w:p>|<\/a:p>|<\/row>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ");
}

async function extractOfficeXml(tempFile: string, extension: string) {
  const patterns: Record<string, string[]> = {
    docx: ["word/document.xml", "word/header*.xml", "word/footer*.xml"],
    pptx: ["ppt/slides/slide*.xml", "ppt/notesSlides/notesSlide*.xml"],
    xlsx: ["xl/sharedStrings.xml", "xl/worksheets/sheet*.xml"],
  };
  const pieces: string[] = [];
  for (const pattern of patterns[extension] || []) {
    try { pieces.push(await commandText("unzip", ["-p", tempFile, pattern])); } catch { /* Missing optional member. */ }
  }
  return xmlToText(pieces.join("\n"));
}

async function extractLegacyOffice(tempFile: string, workDir: string) {
  await execFile("libreoffice", ["--headless", "--convert-to", "txt:Text", "--outdir", workDir, tempFile], { maxBuffer: 4 * 1024 * 1024, timeout: 90_000 });
  const entries = await fs.readdir(workDir);
  const textName = entries.find(name => name.endsWith(".txt"));
  if (!textName) throw new Error("LibreOffice produced no text output");
  return fs.readFile(path.join(workDir, textName), "utf8");
}

function extensionOf(name: string) {
  return path.extname(name).toLowerCase().slice(1);
}

async function readOneUncached(file: DriveFile, tempRoot: string): Promise<ReadDocument> {
  const size = file.size ? Number(file.size) : null;
  const base = { fileId: file.id, fileName: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime, size };
  if (size != null && size > MAX_FILE_BYTES) return { ...base, method: "too_large", status: "too_large", originalCharacters: 0, retainedCharacters: 0, truncated: false, characters: 0, text: "", note: `File exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB read limit` };
  const ext = extensionOf(file.name);
  try {
    if (file.mimeType === GOOGLE_SHORTCUT) {
      const targetId = file.shortcutDetails?.targetId;
      const targetMimeType = file.shortcutDetails?.targetMimeType;
      if (!targetId || !targetMimeType) return { ...base, method: "unsupported", status: "unsupported", originalCharacters: 0, retainedCharacters: 0, truncated: false, characters: 0, text: "", note: "Drive shortcut target metadata is unavailable; open the shortcut manually" };
      const targetResult = await readOneUncached({ ...file, id: targetId, mimeType: targetMimeType, shortcutDetails: undefined }, tempRoot);
      return { ...targetResult, ...base, note: targetResult.note ? `Shortcut target: ${targetResult.note}` : "Resolved through Google Drive shortcut target" };
    }
    let text = "";
    let method: ReadMethod = "unsupported";
    if (file.mimeType === GOOGLE_DOC) {
      text = (await downloadBytes(file, "text/plain")).toString("utf8"); method = "google_export";
    } else if (file.mimeType === GOOGLE_SHEET) {
      text = (await downloadBytes(file, "text/csv")).toString("utf8"); method = "google_export";
    } else if (file.mimeType === GOOGLE_SLIDES) {
      const bytes = await downloadBytes(file, "application/pdf");
      const temp = path.join(tempRoot, `${file.id}.pdf`); await fs.writeFile(temp, bytes);
      text = await commandText("pdftotext", ["-layout", temp, "-"]); method = "google_export";
    } else if (file.mimeType.startsWith("text/") || file.mimeType === "application/json" || ["txt", "json", "csv", "md", "xml", "html", "rtf"].includes(ext)) {
      text = (await downloadBytes(file)).toString("utf8"); method = "text";
    } else if (file.mimeType === "application/pdf" || ext === "pdf") {
      const bytes = await downloadBytes(file); const temp = path.join(tempRoot, `${file.id}.pdf`); await fs.writeFile(temp, bytes);
      text = await commandText("pdftotext", ["-layout", temp, "-"]); method = "pdf";
    } else if (["docx", "pptx", "xlsx"].includes(ext)) {
      const bytes = await downloadBytes(file); const temp = path.join(tempRoot, `${file.id}.${ext}`); await fs.writeFile(temp, bytes);
      text = await extractOfficeXml(temp, ext); method = "office_xml";
    } else if (["doc", "xls", "ppt", "odt", "ods", "odp"].includes(ext)) {
      const bytes = await downloadBytes(file); const work = path.join(tempRoot, `${file.id}-office`); await fs.mkdir(work);
      const temp = path.join(work, `${file.id}.${ext}`); await fs.writeFile(temp, bytes);
      text = await extractLegacyOffice(temp, work); method = "libreoffice";
    } else if (file.mimeType.startsWith("image/") || ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"].includes(ext)) {
      const bytes = await downloadBytes(file); const temp = path.join(tempRoot, `${file.id}.${ext || "img"}`); await fs.writeFile(temp, bytes);
      text = await commandText("tesseract", [temp, "stdout", "-l", "eng"]); method = "ocr";
    } else {
      return { ...base, method: "unsupported", status: "unsupported", originalCharacters: 0, retainedCharacters: 0, truncated: false, characters: 0, text: "", note: "No safe text extractor for this file type" };
    }
    const clean = prepareExtractedText(text);
    return { ...base, method, status: clean.status, originalCharacters: clean.originalCharacters, retainedCharacters: clean.retainedCharacters, truncated: clean.truncated, characters: clean.retainedCharacters, text: clean.text, note: clean.status === "empty" ? "Extractor returned no readable text" : clean.status === "partial" ? `Text retained up to ${MAX_TEXT_PER_FILE.toLocaleString()} characters; manual review is required before outreach` : null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extraction error";
    if (file.mimeType === GOOGLE_SHORTCUT && /Drive HTTP 403/.test(message)) {
      return { ...base, method: "unsupported", status: "unsupported", originalCharacters: 0, retainedCharacters: 0, truncated: false, characters: 0, text: "", note: "Drive shortcut target is not accessible to the service account; human review is required" };
    }
    if (/incorrect password|password/i.test(message)) {
      return { ...base, method: "unsupported", status: "unsupported", originalCharacters: 0, retainedCharacters: 0, truncated: false, characters: 0, text: "", note: "Password-protected file; human access required" };
    }
    if (!/Drive HTTP|fetch failed|timeout|aborted/i.test(message)) {
      return { ...base, method: "unsupported", status: "unsupported", originalCharacters: 0, retainedCharacters: 0, truncated: false, characters: 0, text: "", note: `Extractor could not read this file: ${message.slice(0, 140)}` };
    }
    return { ...base, method: "failed", status: "failed", originalCharacters: 0, retainedCharacters: 0, truncated: false, characters: 0, text: "", note: message.slice(0, 180) };
  }
}

async function readOne(file: DriveFile, tempRoot: string): Promise<ReadDocument> {
  const cacheVersion = file.shortcutDetails?.targetId ? `reader-v3|shortcut-v1|${file.shortcutDetails.targetId}` : "reader-v3";
  const cacheKey = crypto.createHash("sha256").update(`${file.id}|${file.modifiedTime}|${file.size || ""}|${cacheVersion}`).digest("hex");
  const cachePath = path.join(EXTRACTION_CACHE_DIR, `${cacheKey}.json`);
  try {
    return JSON.parse(await fs.readFile(cachePath, "utf8")) as ReadDocument;
  } catch { /* Cache miss. */ }
  const result = await readOneUncached(file, tempRoot);
  if (result.status !== "failed") {
    await fs.mkdir(EXTRACTION_CACHE_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(cachePath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  }
  return result;
}

export function applyFolderTextBudget(documents: ReadDocument[]) {
  let remaining = MAX_TEXT_PER_DEAL;
  for (const document of documents) {
    if (document.text.length > remaining) {
      document.text = document.text.slice(0, Math.max(remaining, 0));
      document.retainedCharacters = document.text.length;
      document.characters = document.retainedCharacters;
      document.truncated = true;
      if (["read", "partial"].includes(document.status)) document.status = "partial";
      const budgetNote = `Folder analysis retained ${document.retainedCharacters.toLocaleString()} of ${document.originalCharacters.toLocaleString()} extracted characters; manual review is required before outreach`;
      document.note = document.note ? `${document.note}; ${budgetNote}` : budgetNote;
    }
    remaining = Math.max(0, remaining - document.text.length);
  }
  return documents;
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export async function readEveryClientFile(deals: DriveDealSnapshot[]): Promise<FullReadResult> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "afg-full-read-"));
  try {
    const bundles = await mapLimit(deals, 3, async deal => {
      const inventory = await listTree(deal.id);
      const documents = await mapLimit(inventory, 3, async (file, index) => {
        const dir = path.join(tempRoot, `${deal.id}-${index}`);
        await fs.mkdir(dir, { recursive: true });
        return readOne(file, dir).catch(error => ({ fileId: file.id, fileName: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime, size: file.size ? Number(file.size) : null, method: "failed" as const, status: "failed" as const, originalCharacters: 0, retainedCharacters: 0, truncated: false, characters: 0, text: "", note: error instanceof Error ? error.message.slice(0, 180) : "Unknown error" }));
      });
      applyFolderTextBudget(documents);
      const hash = crypto.createHash("sha256");
      for (const document of documents) hash.update(`${document.fileId}|${document.modifiedTime}|${document.status}|${document.text}`);
      return {
        dealId: deal.id,
        folderName: deal.folderName,
        inventoryCount: documents.length,
        readableCount: documents.filter(item => item.status === "read").length,
        partialCount: documents.filter(item => item.status === "partial").length,
        emptyCount: documents.filter(item => item.status === "empty").length,
        unsupportedCount: documents.filter(item => item.status === "unsupported").length,
        tooLargeCount: documents.filter(item => item.status === "too_large").length,
        failedCount: documents.filter(item => item.status === "failed").length,
        extractedCharacters: documents.reduce((sum, item) => sum + item.characters, 0),
        contentHash: hash.digest("hex"),
        documents,
      } satisfies DealReadBundle;
    });
    return {
      generatedAt: new Date().toISOString(),
      folderCount: bundles.length,
      inventoryCount: bundles.reduce((sum, item) => sum + item.inventoryCount, 0),
      readableCount: bundles.reduce((sum, item) => sum + item.readableCount, 0),
      partialCount: bundles.reduce((sum, item) => sum + item.partialCount, 0),
      emptyCount: bundles.reduce((sum, item) => sum + item.emptyCount, 0),
      unsupportedCount: bundles.reduce((sum, item) => sum + item.unsupportedCount, 0),
      tooLargeCount: bundles.reduce((sum, item) => sum + item.tooLargeCount, 0),
      failedCount: bundles.reduce((sum, item) => sum + item.failedCount, 0),
      deals: bundles,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
