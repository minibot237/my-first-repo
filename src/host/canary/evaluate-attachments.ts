/**
 * Code-based attachment evaluation — deterministic signals from attachment metadata.
 * Spec: .doc/content-vocabulary.md → Canary Tool Contracts → evaluateAttachments
 */

import type { AttachmentPart } from "../ingest/types.js";
import type { AttachmentSignals, Signal } from "../ingest/types.js";

const DANGEROUS_MIMETYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-executable",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-bat",
  "application/vnd.microsoft.portable-executable",
  "application/hta",
  "application/x-msi",
]);

const DANGEROUS_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".pif", ".vbs", ".vbe",
  ".js", ".jse", ".wsf", ".wsh", ".ps1", ".msi", ".msp", ".hta",
  ".cpl", ".inf", ".reg", ".lnk",
]);

const ARCHIVE_EXTENSIONS = new Set([
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2",
]);

export function evaluateAttachments(attachments: AttachmentPart[]): AttachmentSignals {
  const signals: Signal[] = [];

  for (const att of attachments) {
    const filename = att.filename.toLowerCase();
    const ext = filename.slice(filename.lastIndexOf("."));

    // --- Double extension (e.g. invoice.pdf.exe) ---
    const dots = filename.split(".");
    if (dots.length > 2) {
      const lastExt = `.${dots[dots.length - 1]}`;
      if (DANGEROUS_EXTENSIONS.has(lastExt)) {
        signals.push({
          signal: "double_extension",
          severity: "critical",
          detail: att.filename,
          filename: att.filename,
          mimeType: att.mimeType,
        });
      }
    }

    // --- Dangerous mime type ---
    if (DANGEROUS_MIMETYPES.has(att.mimeType.toLowerCase())) {
      signals.push({
        signal: "dangerous_mimetype",
        severity: "high",
        detail: `${att.filename} (${att.mimeType})`,
        filename: att.filename,
        mimeType: att.mimeType,
      });
    }

    // --- Dangerous extension ---
    if (DANGEROUS_EXTENSIONS.has(ext)) {
      signals.push({
        signal: "dangerous_extension",
        severity: "high",
        detail: att.filename,
        filename: att.filename,
      });
    }

    // --- Archive with misleading name ---
    if (ARCHIVE_EXTENSIONS.has(ext) && /invoice|receipt|payment|document|scan/i.test(att.filename)) {
      signals.push({
        signal: "suspicious_archive_name",
        severity: "medium",
        detail: att.filename,
        filename: att.filename,
      });
    }

    // --- Unusually large attachment ---
    if (att.size > 25_000_000) {
      signals.push({
        signal: "very_large_attachment",
        severity: "low",
        detail: `${att.filename} (${(att.size / 1_000_000).toFixed(1)}MB)`,
        filename: att.filename,
      });
    }

    // --- Zero-byte attachment ---
    if (att.size === 0) {
      signals.push({
        signal: "zero_byte_attachment",
        severity: "low",
        detail: att.filename,
        filename: att.filename,
      });
    }
  }

  return { signals };
}
