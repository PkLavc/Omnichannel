import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { DIMENSIONS } from "../dist/core/embedding.js";
import {
  chunkText,
  extract,
  htmlToText,
  importQuickReplies,
  markdownToText,
} from "../dist/services/importer.js";

function minimalPdf(text: string) {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
  let document = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document, "latin1"));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(document, "latin1");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

async function minimalDocx(text: string) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
    </w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function minimalQuickRepliesXlsx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
      <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
    </Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Respostas" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
      <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
    </Relationships>`);
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>
      <cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0"/></cellXfs>
    </styleSheet>`);
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Nome</t></is></c><c r="B1" t="inlineStr"><is><t>Resposta</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>Agendar</t></is></c><c r="B2" t="inlineStr"><is><t>Informe o serviço e o horário desejado.</t></is></c></row>
    </sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("chunkText creates bounded, overlapping chunks without losing the document", () => {
  const content = Array.from({ length: 35 }, (_, index) =>
    `Parágrafo ${index}: informações detalhadas sobre garantia, aparelho e atendimento ao cliente.`,
  ).join("\n\n");
  const chunks = chunkText(content, { maxCharacters: 400, overlapCharacters: 50, minimumCharacters: 40 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 400));
  assert.match(chunks.join("\n"), /Parágrafo 0/);
  assert.match(chunks.join("\n"), /Parágrafo 34/);
});

test("HTML and Markdown importers remove active/formatting markup and preserve readable text", () => {
  assert.equal(
    htmlToText("<h1>Garantia &amp; reparo</h1><script>ignore()</script><p>Leve a nota.</p>"),
    "Garantia & reparo\nLeve a nota.",
  );
  assert.equal(
    markdownToText("---\ntitle: teste\n---\n# Manual\nConsulte o [suporte](/ajuda) e informe `OS`."),
    "Manual\nConsulte o suporte e informe OS.",
  );
});

test("extract reads real TXT and HTML files and rejects empty input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-import-"));
  try {
    const txt = join(directory, "manual.txt");
    const html = join(directory, "faq.html");
    const empty = join(directory, "empty.md");
    await writeFile(txt, "Linha 1\r\n\r\nLinha 2", "utf8");
    await writeFile(html, "<p>Dúvida</p><p>Resposta</p>", "utf8");
    await writeFile(empty, "", "utf8");
    assert.equal(await extract(txt), "Linha 1\n\nLinha 2");
    assert.equal(await extract(html), "Dúvida\nResposta");
    await assert.rejects(extract(empty), /arquivo está vazio/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("extract reads real PDF and DOCX containers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-binary-import-"));
  try {
    const pdfPath = join(directory, "garantia.pdf");
    const docxPath = join(directory, "atendimento.docx");
    await writeFile(pdfPath, minimalPdf("Manual de garantia da empresa"));
    await writeFile(docxPath, await minimalDocx("Procedimento de atendimento da empresa"));
    assert.match(await extract(pdfPath), /Manual de garantia da empresa/);
    assert.match(await extract(docxPath), /Procedimento de atendimento da empresa/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("quick-replies importer is generic and writes embeddings atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-quick-replies-"));
  const spreadsheet = join(directory, "respostas_rapidas.xlsx");
  await writeFile(spreadsheet, await minimalQuickRepliesXlsx());
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.EMBEDDING_PROVIDER;
  process.env.EMBEDDING_PROVIDER = "ollama";
  let embeddedTexts = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    embeddedTexts += body.input.length;
    const vector = Array.from({ length: DIMENSIONS }, (_, index) => (index === 0 ? 1 : 0));
    return new Response(JSON.stringify({ embeddings: body.input.map(() => vector) }), { status: 200 });
  };
  const stored: Array<{ create: { source: string; content: string; metadata: Record<string, unknown> } }> = [];
  const database = {
    knowledgeDocument: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async (args: { create: { source: string; content: string; metadata: Record<string, unknown> } }) => {
        stored.push(args);
        return { id: `doc-${stored.length}`, ...args.create };
      },
    },
    $executeRaw: async () => 1,
    async $transaction(callback: (transaction: unknown) => unknown) { return callback(this); },
  };
  try {
    const count = await importQuickReplies(
      database as never,
      "tenant-default",
      spreadsheet,
    );
    assert.ok(count > 0);
    assert.ok(stored.length >= count);
    assert.equal(embeddedTexts, stored.length);
    assert.ok(stored.every((entry) => entry.create.source === "respostas_rapidas.xlsx"));
    assert.ok(stored.every((entry) => typeof entry.create.metadata === "object"));
    assert.ok(stored.some((entry) => /Agendar/.test(entry.create.content)));
  } finally {
    await rm(directory, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
    else process.env.EMBEDDING_PROVIDER = originalProvider;
  }
});
