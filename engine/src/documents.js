// Documentos: ver (como imágenes) y crear o editar PDF, Word, PowerPoint y
// Excel. La app dibuja las páginas y ejecuta el código (documents.js); aquí
// solo se definen las herramientas de pi.
//
// ctx: {
//   list() → [{ ref, name, kind, size }],
//   view(document, pages) → { name, ref, total, unit, images: [{ page, mimeType, data }] },
//   run(code, signal) → { logs, result, error, saved: [{ ref, path, size }], declined },
//   acceptsImages
// }
import { Type } from '@earendil-works/pi-ai';

const MAX_OUTPUT_CHARS = 8000;

function clip(text, max) {
  const value = String(text == null ? '' : text);
  return value.length > max ? value.slice(0, max) + '\n… (' + (value.length - max) + ' caracteres más)' : value;
}

function sizeLabel(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

export function createDocumentTools(ctx) {
  return [
    {
      name: 'doc_view',
      label: 'Ver documento',
      description: 'Look at pages of a document of this chat as images, exactly as the user would see them: PDF pages, Word (.docx) pages, PowerPoint (.pptx) slides, Excel (.xlsx) sheets or photos. Use it to check layout, tables, charts, handwriting, scanned pages and every document you create or edit (always look at the result before telling the user it is done). document is a library reference like "D3" or a file name. Up to 6 pages per call.',
      parameters: Type.Object({
        document: Type.String({ description: 'Library reference ("D3") or file name ("informe.docx").' }),
        pages: Type.Optional(Type.String({ description: 'Pages or slides, e.g. "1", "2-4" or "1,5". Default: the first ones.' }))
      }),
      execute: async (id, params) => {
        if (!ctx.acceptsImages) throw new Error('Este modelo no puede ver imágenes: lee el texto con read_library. Para ver documentos elige un modelo con visión.');
        const result = await ctx.view(params.document, params.pages);
        const head = (result.ref ? result.ref + ' · ' : '') + result.name + ' · ' + result.total + ' ' + result.unit + (result.total === 1 ? '' : 's') +
          ' · se muestran: ' + result.images.map((image) => image.page).join(', ');
        const content = [{ type: 'text', text: head }];
        result.images.forEach((image) => {
          content.push({ type: 'text', text: result.unit.charAt(0).toUpperCase() + result.unit.slice(1) + ' ' + image.page + ':' });
          content.push({ type: 'image', mimeType: image.mimeType, data: image.data });
        });
        return { content, details: { ref: result.ref || '', pages: result.images.length } };
      }
    },
    {
      name: 'doc_edit',
      label: 'Crear o editar documento',
      description: [
        'Create or edit PDF, Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) files with JavaScript, in a sandbox without network or DOM (top-level await works, 90 s limit). The new files are saved in this chat\'s library and the user can open and download them.',
        'Available: PDFLib (pdf-lib: create, fill forms, add text/images/pages, merge, split, rotate), docx (docx library: new docx.Document({ sections: [...] }), Paragraph, TextRun, HeadingLevel, Table...), PptxGenJS (new PptxGenJS(), pptx.addSlide().addText/addShape/addTable/addImage(data:...)), JSZip (edit the XML inside an existing .docx/.pptx/.xlsx to keep its exact design) and XLSX (SheetJS).',
        'API: listDocuments() → [{ ref, name, kind, size }]; await readDocument("D3" or name) → Uint8Array; saveDocument(name, data) where data is bytes, a pdf-lib PDFDocument, a docx.Document, a PptxGenJS presentation, a JSZip or a SheetJS workbook. console.log and return are shown to you.',
        'To edit a file, read it and save the result (same name to replace your own earlier version, a new name like "contrato-v2.docx" to keep the user\'s original). For small text changes in an existing Word/PowerPoint, edit its XML with JSZip so the design stays. Read the text first with read_library; afterwards check the result with doc_view.'
      ].join(' '),
      parameters: Type.Object({
        code: Type.String({ description: 'JavaScript to run.' })
      }),
      executionMode: 'sequential',
      execute: async (id, params, signal) => {
        const outcome = await ctx.run(params.code, signal);
        const sections = [];
        if (outcome.logs && outcome.logs.length) sections.push('console:\n' + outcome.logs.join('\n'));
        if (outcome.result !== undefined) sections.push('return:\n' + outcome.result);
        if (outcome.saved && outcome.saved.length) sections.push('guardado en la biblioteca: ' + outcome.saved.map((doc) => doc.ref + ' ' + doc.path + ' (' + sizeLabel(doc.size) + ')').join(', ') + '. Míralo con doc_view antes de dar el trabajo por hecho.');
        if (outcome.declined) sections.push('El usuario no ha aprobado guardar ' + outcome.declined + '. No lo repitas sin preguntarle qué quiere cambiar.');
        if (outcome.error) sections.push('error:\n' + outcome.error);
        const text = clip(sections.join('\n\n') || '(sin salida; usa saveDocument para guardar)', MAX_OUTPUT_CHARS);
        return {
          content: [{ type: 'text', text }],
          details: { documents: (outcome.saved || []).map((doc) => ({ ref: doc.ref, id: doc.id, path: doc.path, size: doc.size, kind: doc.kind })) },
          isError: !!outcome.error || !!outcome.declined
        };
      }
    }
  ];
}
