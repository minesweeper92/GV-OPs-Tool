import { randomUUID as uuid } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Problem } from "./domain.ts";

export const attachmentLimit = 10 * 1024 * 1024;
export const attachmentRequestLimit =
  Math.ceil((attachmentLimit * 4) / 3) + 16_384;
const root = resolve(process.env.GV_ATTACHMENT_ROOT || ".data/attachments");
const mimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
]);
const types = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  office:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};

export function decodeAttachment(
  filename: string,
  contentType: string,
  data: string,
) {
  if (!mimeTypes.has(contentType))
    throw new Problem(400, "Choose a PDF, image, Office document or CSV file.");
  const safeName = filename
    .normalize("NFC")
    .replaceAll("\\", "/")
    .split("/")
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  if (!safeName) throw new Problem(400, "The file needs a name.");
  if (
    data.length > attachmentRequestLimit ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data,
    )
  )
    throw new Problem(400, "The file data is invalid or too large.");
  const bytes = Buffer.from(data, "base64");
  if (
    !bytes.length ||
    bytes.length > attachmentLimit ||
    bytes.toString("base64") !== data
  )
    throw new Problem(400, "Each attachment must be smaller than 10 MB.");
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  const valid =
    (contentType === types.pdf &&
      bytes.subarray(0, 5).toString() === "%PDF-") ||
    (contentType === types.jpeg && starts(0xff, 0xd8, 0xff)) ||
    (contentType === types.png &&
      starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) ||
    (contentType === types.webp &&
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP") ||
    ([types.office, types.sheet].includes(contentType as typeof types.office) &&
      starts(0x50, 0x4b, 0x03, 0x04)) ||
    (contentType === types.csv && !bytes.includes(0) && isUtf8(bytes));
  if (!valid)
    throw new Problem(400, "The selected file does not match its file type.");
  return { filename: safeName, contentType, bytes };
}

function isUtf8(bytes: Buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export async function persistAttachment(id: string, bytes: Buffer) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, id), bytes, { flag: "wx", mode: 0o600 });
}

export async function removeAttachmentFile(id: string) {
  await unlink(join(root, id)).catch(() => undefined);
}

export async function readAttachmentFile(id: string) {
  return readFile(join(root, id));
}
