/**
 * Builds the class-notes PDF with PDFKit.
 *
 * PDFKit is pure JavaScript — no Chromium/Puppeteer needed — which matters
 * because shared hosting (the target for this app) often can't run a
 * headless browser at all. This keeps PDF generation cheap and reliable.
 */

const PDFDocument = require('pdfkit');

const NAVY = '#1a2840';
const GOLD = '#f2b530';
const BODY = '#333333';
const MUTED = '#777777';

function drawHeader(doc, notesData) {
  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);

  doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold')
    .text('LiveClass Board', 40, 26);
  doc.fontSize(10).font('Helvetica').fillColor('#c7d0e8')
    .text('Teacher Writes Once. Every Student Sees It Live.', 40, 50);

  doc.fillColor(GOLD).fontSize(11).font('Helvetica-Bold')
    .text(notesData.subject || 'Class Notes', 40, 68);

  doc.fillColor('#333333');
  doc.y = 110;
}

function drawMeta(doc, notesData) {
  const rows = [
    ['Class', notesData.className || '—'],
    ['Topic', notesData.topic || '—'],
    ['Teacher', notesData.teacherName || '—'],
    ['Date', notesData.date],
  ];
  const startY = doc.y;
  rows.forEach(([label, value], i) => {
    const y = startY + i * 16;
    doc.fontSize(9).fillColor(MUTED).font('Helvetica').text(label.toUpperCase(), 40, y, { width: 90 });
    doc.fontSize(10).fillColor(BODY).font('Helvetica-Bold').text(value, 130, y, { width: 400 });
  });
  doc.moveDown(2);
  doc.y = startY + rows.length * 16 + 18;
  doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor('#e0e0e0').stroke();
  doc.moveDown(1);
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - 60) doc.addPage();
}

function drawSection(doc, section, index) {
  ensureSpace(doc, 40);
  doc.fontSize(13).fillColor(NAVY).font('Helvetica-Bold')
    .text(`${index}. ${section.title}`, 40, doc.y);
  doc.moveDown(0.5);

  if (section.type === 'notes') {
    doc.fontSize(10.5).fillColor(BODY).font('Helvetica');
    const lines = section.content.split('\n');
    for (const line of lines) {
      ensureSpace(doc, 16);
      if (line.startsWith('# ')) {
        doc.fontSize(12).font('Helvetica-Bold').text(line.slice(2), 40, doc.y, { width: doc.page.width - 80 });
        doc.fontSize(10.5).font('Helvetica');
      } else if (line.startsWith('- ')) {
        doc.text('•  ' + line.slice(2), 50, doc.y, { width: doc.page.width - 90 });
      } else {
        doc.text(line || ' ', 40, doc.y, { width: doc.page.width - 80 });
      }
    }
    doc.moveDown(1);
  }

  if (section.type === 'code') {
    ensureSpace(doc, 24);
    doc.fontSize(9).fillColor(MUTED).font('Helvetica-Oblique')
      .text(`Language: ${section.language}`, 40, doc.y);
    doc.moveDown(0.4);

    const codeLines = section.content.split('\n');
    const blockHeight = codeLines.length * 13 + 16;
    ensureSpace(doc, Math.min(blockHeight, 200));

    const boxTop = doc.y;
    doc.save();
    doc.roundedRect(40, boxTop, doc.page.width - 80, blockHeight, 4).fill('#f4f6fa');
    doc.restore();

    let y = boxTop + 8;
    doc.font('Courier').fontSize(9).fillColor('#1a2840');
    for (const line of codeLines) {
      if (y > doc.page.height - 70) {
        doc.addPage();
        y = 40;
      }
      doc.text(line || ' ', 50, y, { width: doc.page.width - 100 });
      y += 13;
    }
    doc.y = y + 10;
  }

  if (section.type === 'whiteboard') {
    doc.fontSize(10).fillColor(BODY).font('Helvetica')
      .text(`The whiteboard was used during this class (${section.strokeCount} strokes recorded).`, 40, doc.y, { width: doc.page.width - 80 });
    if (section.imageBuffer) {
      doc.moveDown(0.5);
      try {
        const maxW = doc.page.width - 80;
        doc.image(section.imageBuffer, 40, doc.y, { width: maxW, fit: [maxW, 320] });
        doc.moveDown(1);
      } catch {
        // If the image fails to decode, the text note above still stands.
      }
    }
    doc.moveDown(1);
  }
}

/** Streams a finished PDF to `res` (an Express response). */
function generateNotesPdf(notesData, res, filename) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  drawHeader(doc, notesData);
  drawMeta(doc, notesData);

  if (notesData.sections.length === 0) {
    doc.fontSize(11).fillColor(MUTED).text('No content was captured during this class.', 40, doc.y);
  } else {
    notesData.sections.forEach((s, i) => drawSection(doc, s, i + 1));
  }

  // Footer page numbers.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor(MUTED)
      .text(`LiveClass Board — Page ${i + 1} of ${range.count}`, 40, doc.page.height - 40, {
        width: doc.page.width - 80,
        align: 'center',
      });
  }

  doc.end();
}

module.exports = { generateNotesPdf };
