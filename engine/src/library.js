// Herramientas de la biblioteca del chat: PDFs, carpetas, fotos y documentos
// que el usuario ha subido. La app guarda y busca (library.js); aquí solo se
// definen las herramientas de pi que el modelo usa para encontrar lo que necesita.
import { Type } from '@earendil-works/pi-ai';

function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

function describe(doc) {
  const bits = [doc.kind === 'pdf' ? 'PDF, ' + doc.totalPages + ' págs.' : doc.kind === 'image' ? 'imagen' : doc.pages + ' secciones'];
  if (doc.words) bits.push('~' + doc.words + ' palabras');
  if (doc.pendingOcr) bits.push('OCR en curso (' + doc.pendingOcr + ')');
  return bits.join(', ');
}

// library: { list(), search(query, {limit, doc}), read(ref, pages), image(ref), acceptsImages }
export function createLibraryTools(library) {
  const tools = [
    {
      name: 'search_library',
      label: 'Buscar en la biblioteca',
      description: 'Search all the files the user uploaded to this chat (PDFs, folders, photos read with OCR, documents). Returns the best matching pages with a snippet and a reference like D3:p12. Search before answering anything about the user\'s material, with the key terms (several searches with different words are fine), then read the pages you need with read_library.',
      parameters: Type.Object({
        query: Type.String({ description: 'Key words or a short phrase, in the language of the documents.' }),
        doc: Type.Optional(Type.String({ description: 'Only this document, e.g. "D3".' })),
        limit: Type.Optional(Type.Number({ description: 'How many results (default 8, max 20).' }))
      }),
      execute: async (toolCallId, params) => {
        const result = await library.search(params.query, { limit: params.limit, doc: params.doc });
        if (!result.hits.length) {
          return textResult('Nada para «' + params.query + '». Prueba con otras palabras, sinónimos o el término exacto del documento; list_library muestra qué hay.');
        }
        const lines = result.hits.map((hit, index) => (index + 1) + '. ' + hit.ref + ' · ' + hit.name + (hit.kind === 'pdf' ? ' · pág. ' + hit.page : '') +
          (hit.image ? ' · tiene imagen' : '') + '\n   ' + (hit.snippet || '(sin texto)'));
        return textResult(lines.join('\n') + (result.total > result.hits.length ? '\n(' + result.total + ' fragmentos coinciden; mostrando los mejores)' : ''), { hits: result.hits.length });
      }
    },
    {
      name: 'read_library',
      label: 'Leer de la biblioteca',
      description: 'Read pages of an uploaded document. ref is a document (D3) or a page (D3:p12); pages is an optional range like "12-15". Long documents are returned in parts: ask for the next pages when needed.',
      parameters: Type.Object({
        ref: Type.String({ description: 'Document or page reference, e.g. "D3" or "D3:p12".' }),
        pages: Type.Optional(Type.String({ description: 'Page or section range, e.g. "12" or "12-15".' }))
      }),
      execute: async (toolCallId, params) => {
        const result = await library.read(params.ref, params.pages);
        if (!result) throw new Error('No existe ' + params.ref + ' en la biblioteca. Usa list_library o search_library.');
        const head = result.doc.ref + ' · ' + result.doc.path + ' (' + describe(result.doc) + ')';
        const more = result.more ? '\n\n[Sigue en ' + result.doc.ref + ':p' + result.more + ']' : '';
        return textResult(head + '\n\n' + (result.text || '(sin texto en esas páginas)') + more, { ref: result.doc.ref });
      }
    },
    {
      name: 'list_library',
      label: 'Ver la biblioteca',
      description: 'List every file uploaded to this chat with its reference, folder path and size.',
      parameters: Type.Object({}),
      execute: async () => {
        const docs = await library.list();
        if (!docs.length) return textResult('La biblioteca de este chat está vacía.');
        return textResult(docs.map((doc) => doc.ref + ' · ' + doc.path + ' · ' + describe(doc)).join('\n'));
      }
    },
    {
      name: 'view_library_image',
      label: 'Ver imagen',
      description: 'Look at an uploaded photo or a scanned PDF page (diagrams, handwriting, formulas the OCR may have misread). ref is the document (D5) or a page (D3:p7).',
      parameters: Type.Object({
        ref: Type.String({ description: 'Image or page reference, e.g. "D5" or "D3:p7".' })
      }),
      execute: async (toolCallId, params) => {
        const result = await library.image(params.ref);
        if (!result) throw new Error('No existe ' + params.ref + ' en la biblioteca.');
        if (result.missing) throw new Error(params.ref + ' no tiene imagen: léelo con read_library.');
        const label = result.doc.ref + ':p' + result.page + ' · ' + result.doc.path;
        if (!library.acceptsImages) {
          return textResult(label + '\nEste modelo no puede ver imágenes. Texto leído por OCR:\n' + (result.text || '(ninguno)'));
        }
        return {
          content: [{ type: 'text', text: label + (result.text ? '\nTexto leído por OCR (puede tener errores):\n' + result.text.slice(0, 4000) : '') }, { type: 'image', data: result.data, mimeType: result.mimeType }],
          details: { ref: result.doc.ref }
        };
      }
    }
  ];
  if (typeof library.remove === 'function') {
    tools.push({
      name: 'delete_library',
      label: 'Borrar de la biblioteca',
      description: 'Delete a document of this chat\'s library (one you generated and no longer need, or one the user asks you to remove). ref is the document, e.g. "D3". Never delete what the user uploaded unless they ask.',
      parameters: Type.Object({
        ref: Type.String({ description: 'Document reference, e.g. "D3".' })
      }),
      executionMode: 'sequential',
      execute: async (toolCallId, params) => {
        const result = await library.remove(String(params.ref || '').trim());
        if (!result) throw new Error('No existe ' + params.ref + ' en la biblioteca. Usa list_library.');
        if (result.declined) return { content: [{ type: 'text', text: 'El usuario no ha aprobado borrar ' + result.ref + '. No lo repitas sin preguntarle.' }], details: {}, isError: true };
        return textResult('Borrado ' + result.ref + ' · ' + result.path + ' de la biblioteca.', { ref: result.ref });
      }
    });
  }
  return tools;
}
