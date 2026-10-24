// Gmail de una cuenta de Google, solo lectura (gmail.readonly): buscar con la
// misma sintaxis que el buscador de Gmail y leer un correo entero. Nada envía,
// borra ni marca nada.
//
// ctx: { fetch(url, options) → Response con el token de esa cuenta, prefix?,
//   account?, signal }
import { Type } from '@earendil-works/pi-ai';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_READ_CHARS = 40000;

function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

function decodeBody(data) {
  const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The readable text of a message: text/plain if there is one, else the HTML as text.
function bodyOf(payload) {
  const plain = [];
  const html = [];
  const files = [];
  (function walk(part) {
    if (!part) return;
    if (part.filename && part.body && (part.body.attachmentId || part.body.size)) files.push(part.filename + (part.body.size ? ' (' + Math.max(1, Math.round(part.body.size / 1024)) + ' KB)' : ''));
    else if (part.mimeType === 'text/plain' && part.body && part.body.data) plain.push(decodeBody(part.body.data));
    else if (part.mimeType === 'text/html' && part.body && part.body.data) html.push(htmlToText(decodeBody(part.body.data)));
    (part.parts || []).forEach(walk);
  })(payload);
  return { text: (plain.length ? plain.join('\n\n') : html.join('\n\n')).trim(), files };
}

const header = (message, name) => {
  const found = ((message.payload && message.payload.headers) || []).find((item) => item.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
};

export function createGmailTools(ctx) {
  async function json(url, what) {
    const response = await ctx.fetch(url, { signal: ctx.signal });
    if (!response.ok) {
      let message = '';
      try { const data = await response.json(); message = data && data.error && data.error.message; } catch (_) {}
      const error = new Error('Gmail ' + response.status + (what ? ' al ' + what : '') + ': ' + (message || response.statusText || 'error') + (response.status === 401 ? ' (la sesión de esa cuenta ha caducado: vuelve a vincularla)' : response.status === 403 ? ' (Google no dio permiso de leer el correo: vuelve a vincular la cuenta y marca Gmail)' : ''));
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  const prefix = ctx.prefix || '';
  const accountNote = ctx.account ? ' (Google account ' + ctx.account + ', read-only)' : '';

  return [
    {
      name: prefix + 'gmail_search',
      label: 'Gmail: buscar',
      description: 'Search the emails' + accountNote + ' with Gmail search syntax, e.g. "from:ana factura", "subject:(examen) after:2026/01/01", "has:attachment filename:pdf", "in:anywhere" to include spam and trash. Returns id, date, sender, subject and a snippet; read one with ' + prefix + 'gmail_read.',
      parameters: Type.Object({
        query: Type.String({ description: 'Gmail search, as typed in Gmail\'s search box.' }),
        limit: Type.Optional(Type.Number({ description: 'How many (default 15, max 40).' }))
      }),
      execute: async (id, params) => {
        const limit = Math.min(40, Math.max(1, Number(params.limit) || 15));
        const list = await json(API + '/messages?' + new URLSearchParams({ q: String(params.query || ''), maxResults: String(limit) }), 'buscar');
        const ids = (list.messages || []).map((item) => item.id);
        if (!ids.length) return textResult('Ningún correo coincide con «' + params.query + '».', { count: 0 });
        const rows = await Promise.all(ids.map(async (messageId) => {
          const message = await json(API + '/messages/' + encodeURIComponent(messageId) + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date', 'leer un correo');
          return 'id ' + message.id + ' · ' + header(message, 'Date') + ' · de ' + header(message, 'From') + '\n   «' + (header(message, 'Subject') || '(sin asunto)') + '» — ' + String(message.snippet || '').slice(0, 200);
        }));
        return textResult(rows.join('\n') + (list.nextPageToken ? '\n(Hay más resultados: afina la búsqueda.)' : ''), { count: ids.length });
      }
    },
    {
      name: prefix + 'gmail_read',
      label: 'Gmail: leer',
      description: 'Read one email' + accountNote + ' in full: sender, recipients, date, subject, text and the names of its attachments. Long emails are read in parts with from.',
      parameters: Type.Object({
        id: Type.String({ description: 'Email id from ' + prefix + 'gmail_search.' }),
        from: Type.Optional(Type.Number({ description: 'Character to start at, for long emails.' }))
      }),
      execute: async (id, params) => {
        const messageId = String(params.id || '').trim();
        if (!/^[\w-]{1,100}$/.test(messageId)) throw new Error('Id de correo no válido.');
        const message = await json(API + '/messages/' + encodeURIComponent(messageId) + '?format=full', 'leer el correo');
        const body = bodyOf(message.payload);
        const start = Math.max(0, Math.floor(Number(params.from) || 0));
        const part = body.text.slice(start, start + MAX_READ_CHARS);
        const rest = body.text.length - start - part.length;
        return textResult([
          'De: ' + header(message, 'From'),
          'Para: ' + header(message, 'To') + (header(message, 'Cc') ? '\nCc: ' + header(message, 'Cc') : ''),
          'Fecha: ' + header(message, 'Date'),
          'Asunto: ' + (header(message, 'Subject') || '(sin asunto)'),
          body.files.length ? 'Adjuntos: ' + body.files.join(', ') : '',
          '',
          part || '(sin texto)',
          rest > 0 ? '\n… (quedan ' + rest + ' caracteres: vuelve a leer con from=' + (start + part.length) + ')' : ''
        ].filter((line, index) => line || index === 5).join('\n'), { id: message.id });
      }
    }
  ];
}
