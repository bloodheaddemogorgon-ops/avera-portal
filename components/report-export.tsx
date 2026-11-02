"use client";

import { useState } from "react";

export function ReportExport() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function exportReport() {
    const report = document.getElementById("dashboard-report");
    if (!report) return;
    setBusy(true);
    setMessage("");
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const canvas = await html2canvas(report, { scale: 2, backgroundColor: "#f5f7f4", useCORS: true });
      const pdf = new jsPDF("p", "mm", "a4");
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight() - 20;
      const imageHeight = (canvas.height * (pageWidth - 24)) / canvas.width;
      const pageCanvas = document.createElement("canvas");
      const pageContext = pageCanvas.getContext("2d");
      if (!pageContext) throw new Error("Could not prepare the report image.");
      pageCanvas.width = canvas.width;
      const pixelsPerPage = Math.floor((pageHeight * canvas.width) / (pageWidth - 24));
      let offset = 0;
      while (offset < canvas.height) {
        const sliceHeight = Math.min(pixelsPerPage, canvas.height - offset);
        pageCanvas.height = sliceHeight;
        pageContext.clearRect(0, 0, pageCanvas.width, sliceHeight);
        pageContext.drawImage(canvas, 0, offset, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
        if (offset > 0) pdf.addPage();
        const sliceImage = pageCanvas.toDataURL("image/png");
        const slicePdfHeight = (sliceHeight * (pageWidth - 24)) / canvas.width;
        pdf.addImage(sliceImage, "PNG", 12, 10, pageWidth - 24, slicePdfHeight);
        offset += sliceHeight;
      }
      pdf.save("avera-class-overview.pdf");
      setMessage(`Report exported (${Math.ceil(imageHeight / pageHeight)} page${imageHeight > pageHeight ? "s" : ""}).`);
    } catch {
      setMessage("The report could not be exported. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <div><button className="quiet-button" type="button" onClick={exportReport} disabled={busy}>{busy ? "Preparing report…" : "Export PDF"}</button>{message && <p className="report-error" role="status">{message}</p>}</div>;
}