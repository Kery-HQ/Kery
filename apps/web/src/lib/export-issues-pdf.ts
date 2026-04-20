import { jsPDF } from "jspdf";
import { projectBugDetailDescription } from "@/lib/bug-issue-display";
import { runScreenshotFileUrl, screenshotRefToSrc } from "@/lib/apiAssets";

export type ExportIssueRow = {
  name: string;
  description: string;
  category: "visual" | "functional" | "ux" | "other";
  severity: "low" | "medium" | "high";
  status: "open" | "in_progress" | "resolved" | "wont_fix";
  url?: string | null;
  environment?: string | null;
  reportedAt?: string;
  reported_at?: string;
  test_id?: string | null;
  destination_id?: string | null;
  test_name?: string | null;
  run_id?: string;
  runId: string;
  screenshot_path?: string | null;
  screenshotPath?: string | null;
  screenshot_base64?: string | null;
  screenshotBase64?: string | null;
};

// ── Palette ───────────────────────────────────────────────────────────────────
type RGB = [number, number, number];

const C = {
  dark:    [28,  33,  30]  as RGB,
  muted:   [128, 138, 132] as RGB,
  faint:   [175, 185, 180] as RGB,
  rule:    [218, 226, 222] as RGB,
  hdrBg:   [238, 244, 241] as RGB,
  high:    [181, 54,  54]  as RGB,
  medium:  [156, 106, 22]  as RGB,
  low:     [52,  116, 80]  as RGB,
  brand:   [68,  110, 88]  as RGB,
} as const;

const SEV_COLOR: Record<string, RGB> = { high: C.high, medium: C.medium, low: C.low };
const SEV_LABEL: Record<string, string> = { high: "HIGH", medium: "MED", low: "LOW" };
const CAT_LABEL: Record<string, string> = { visual: "Visual", functional: "Functional", ux: "UX", other: "Other" };
const STATUS_LABEL: Record<string, string> = {
  open: "Open", in_progress: "In Progress", resolved: "Resolved", wont_fix: "Won't Fix",
};

// ── Image helpers ─────────────────────────────────────────────────────────────
type ImgData = { data: string; format: "JPEG" | "PNG"; w: number; h: number };

async function loadImage(issue: ExportIssueRow): Promise<ImgData | null> {
  const runKey = issue.run_id ?? issue.runId;
  const fileUrl = runScreenshotFileUrl(runKey, issue.screenshot_path ?? issue.screenshotPath);
  const legacy  = screenshotRefToSrc(issue.screenshot_base64 ?? issue.screenshotBase64 ?? undefined);
  const src = fileUrl ?? legacy;
  if (!src) return null;

  let dataUrl = src;
  let format: "JPEG" | "PNG" = "JPEG";

  if (!src.startsWith("data:")) {
    try {
      const res = await fetch(src);
      if (!res.ok) return null;
      const blob = await res.blob();
      format = blob.type.includes("png") ? "PNG" : "JPEG";
      dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  } else {
    format = src.startsWith("data:image/png") ? "PNG" : "JPEG";
  }

  const dims = await new Promise<{ w: number; h: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 16, h: 9 });
    img.src = dataUrl;
  });

  return { data: dataUrl, format, ...dims };
}

// ── Utility ───────────────────────────────────────────────────────────────────
function formatDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function safeFilename(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "issues";
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function downloadIssuesPdf(opts: {
  projectName?: string | null;
  issues: ExportIssueRow[];
}) {
  const { projectName, issues } = opts;

  // Load all screenshots before touching the PDF
  const images = await Promise.all(issues.map(loadImage));

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const PW = doc.internal.pageSize.getWidth();   // 210
  const PH = doc.internal.pageSize.getHeight();  // 297
  const ML = 14;   // left margin
  const MR = 14;   // right margin
  const CW = PW - ML - MR;  // 182 — content width
  const FOOTER_H = 10;
  const SAFE_BOTTOM = PH - MR - FOOTER_H;

  let y = ML;

  // ── Renderer helpers ────────────────────────────────────────────────────────
  const lh = (fs: number) => fs * 0.43; // mm per line for a given font size

  function guard(needed: number) {
    if (y + needed > SAFE_BOTTOM) {
      doc.addPage();
      y = ML + 4;
    }
  }

  function color(rgb: RGB) { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }
  function fill(rgb: RGB)  { doc.setFillColor(rgb[0], rgb[1], rgb[2]); }
  function draw(rgb: RGB)  { doc.setDrawColor(rgb[0], rgb[1], rgb[2]); }

  function span(
    str: string, x: number, yPos: number,
    opts?: { fs?: number; bold?: boolean; col?: RGB; align?: "left" | "right" | "center" },
  ) {
    if (opts?.col) color(opts.col);
    if (opts?.fs) doc.setFontSize(opts.fs);
    doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
    doc.text(str, x, yPos, { align: opts?.align ?? "left" });
  }

  function paragraph(
    str: string, x: number, maxW: number,
    opts?: { fs?: number; bold?: boolean; col?: RGB; leading?: number },
  ): number {
    const fs = opts?.fs ?? 10;
    const lead = opts?.leading ?? 1.35;
    if (opts?.col) color(opts.col);
    doc.setFontSize(fs);
    doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
    const lines: string[] = doc.splitTextToSize(str, maxW);
    const lineH = lh(fs) * lead;
    for (const line of lines) {
      guard(lineH);
      if (opts?.col) color(opts.col);
      doc.setFontSize(fs);
      doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
      doc.text(line, x, y);
      y += lineH;
    }
    return lines.length;
  }

  function hrule(col: RGB = C.rule, w = 0.18) {
    draw(col);
    doc.setLineWidth(w);
    doc.line(ML, y, PW - MR, y);
  }

  // ── Page header (first page) ─────────────────────────────────────────────
  const HDR_H = 46;
  fill(C.hdrBg);
  draw(C.hdrBg);
  doc.rect(0, 0, PW, HDR_H, "F");

  y = 12;
  span("KERY", ML, y, { fs: 8, bold: true, col: C.brand });
  span(
    new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    PW - MR, y, { fs: 8, col: C.muted, align: "right" },
  );

  y = 23;
  span("Issues Report", ML, y, { fs: 19, bold: true, col: C.dark });
  y += lh(19) + 1.5;

  if (projectName) {
    span(projectName, ML, y, { fs: 10.5, col: C.muted });
    y += lh(10.5) + 1.5;
  }

  span(
    `${issues.length} issue${issues.length === 1 ? "" : "s"}`,
    ML, y, { fs: 8.5, col: C.faint },
  );

  y = HDR_H + 6;

  // ── Issues ───────────────────────────────────────────────────────────────
  const INDENT = ML + 5;  // title / body indent (dot lives 0–5)
  const BODY_W = CW - 5;

  for (let i = 0; i < issues.length; i++) {
    const bug = issues[i];
    const img = images[i];
    const detail    = projectBugDetailDescription(bug);
    const reported  = bug.reportedAt ?? bug.reported_at;
    const sevColor  = SEV_COLOR[bug.severity] ?? C.muted;

    const source =
      bug.test_id != null
        ? `Flow${bug.test_name ? ` · ${bug.test_name}` : ""}`
        : bug.destination_id != null
          ? "Page"
          : null;

    const metaParts = [
      CAT_LABEL[bug.category]    ?? bug.category,
      STATUS_LABEL[bug.status]   ?? bug.status,
      ...(source ? [source] : []),
      ...(bug.environment ? [bug.environment] : []),
      ...(reported ? [formatDate(reported)] : []),
    ];

    // Ensure enough room to at least start
    guard(18);

    // ── Severity dot ─────────────────────────────────────────────
    fill(sevColor);
    draw(sevColor);
    doc.ellipse(ML + 1.7, y - 1.6, 1.5, 1.5, "F");

    // ── Title + severity label ────────────────────────────────────
    doc.setFontSize(11.5);
    doc.setFont("helvetica", "bold");
    const titleLines: string[] = doc.splitTextToSize(bug.name, BODY_W - 12);

    // Severity right-aligned on first line
    span(
      SEV_LABEL[bug.severity] ?? bug.severity.toUpperCase(),
      PW - MR, y, { fs: 7.5, bold: true, col: sevColor, align: "right" },
    );

    color(C.dark);
    doc.setFontSize(11.5);
    doc.setFont("helvetica", "bold");
    for (let tl = 0; tl < titleLines.length; tl++) {
      if (tl > 0) guard(lh(11.5) * 1.3);
      doc.text(titleLines[tl], INDENT, y);
      y += lh(11.5) * 1.3;
    }
    y += 1;

    // ── Meta line ────────────────────────────────────────────────
    paragraph(metaParts.join(" · "), INDENT, BODY_W, { fs: 8.5, col: C.muted, leading: 1.3 });
    y += 2;

    // ── URL ──────────────────────────────────────────────────────
    if (bug.url) {
      paragraph(bug.url, INDENT, BODY_W, { fs: 8, col: C.faint, leading: 1.3 });
      y += 1.5;
    }

    // ── Description ──────────────────────────────────────────────
    if (detail) {
      paragraph(detail, INDENT, BODY_W, { fs: 9.5, col: C.dark, leading: 1.45 });
      y += 2;
    }

    // ── Screenshot ───────────────────────────────────────────────
    if (img) {
      const ratio   = img.h / img.w;
      const imgW    = CW;
      const imgH    = Math.min(imgW * ratio, 90);
      guard(imgH + 4);
      y += 1;
      // Subtle rounded-corner look via a slightly larger bg rect
      fill([248, 250, 249]);
      draw(C.rule);
      doc.setLineWidth(0.18);
      doc.rect(ML, y, imgW, imgH, "FD");
      try {
        doc.addImage(img.data, img.format, ML, y, imgW, imgH);
      } catch { /* skip broken image */ }
      y += imgH + 3;
    }

    y += 4;

    // Separator between issues
    if (i < issues.length - 1) {
      guard(1);
      hrule(C.rule, 0.15);
      y += 6;
    }
  }

  // ── Page footers ─────────────────────────────────────────────────────────
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    color(C.faint);
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.text(`${p} / ${total}`, PW - MR, PH - 6, { align: "right" });
    if (p > 1) {
      // Running header on continuation pages
      doc.setFontSize(7.5);
      color(C.muted);
      const hdr = projectName ? `Kery · Issues Report · ${projectName}` : "Kery · Issues Report";
      doc.text(hdr, ML, 8);
      // thin rule under it
      draw(C.rule);
      doc.setLineWidth(0.15);
      doc.line(ML, 10, PW - MR, 10);
    }
  }

  const stamp    = new Date().toISOString().slice(0, 10);
  const filePart = safeFilename(projectName ?? "issues");
  doc.save(`kery-issues-${filePart}-${stamp}.pdf`);
}
