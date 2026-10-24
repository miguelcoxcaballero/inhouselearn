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

// What a Google API error means for the user, in words they can act on.
export function googleProblem(status, data, api) {
  const error = (data && data.error) || {};
  const message = String(error.message || '');
  const reasons = [].concat(error.errors || [], error.details || []).map((item) => String((item && item.reason) || '')).join(' ');
  if (/SERVICE_DISABLED|accessNotConfigured/.test(reasons) || /has not been used in project|is disabled/i.test(message)) {
    return { kind: 'disabled', text: 'la API de ' + api + ' no está activada en el proyecto de Google Cloud de la app. Si se acaba de activar, Google tarda unos minutos en aplicarlo: vuelve a intentarlo en un rato; no hace falta volver a vincular la cuenta.' };
  }
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/.test(reasons) || /insufficient authentication scopes|insufficient permission/i.test(message)) {
    return { kind: 'scope', text: 'esa cuenta no dio permiso para ' + api + ': quítala del cuadro de texto, vuelve a vincularla y deja marcada la casilla de ' + api + ' en la pantalla de Google.' };
  }
  if (status === 401) return { kind: 'expired', text: 'la sesión de esa cuenta ha caducado: quítala y vuelve a vincularla.' };
  if (/admin|domain|policy|organization/i.test(message + ' ' + reasons)) {
    return { kind: 'admin', text: 'el administrador de esa cuenta (Google Workspace) no deja que esta app lea ' + api + ': ' + message };
  }
  return { kind: 'other', text: message || 'error' };
}

export function createGmailTools(ctx) {
  // A Google API that was just turned on in Google Cloud takes a few minutes
  // to answer: SERVICE_DISABLED is retried a few times before giving up.
  async function json(url, what) {
    for (let attempt = 0; ; attempt++) {
      const response = await ctx.fetch(url, { signal: ctx.signal });
      if (response.ok) return response.json();
      let data = null;
      try { data = await response.json(); } catch (_) {}
      const problem = googleProblem(response.status, data, 'Gmail');
      if (problem.kind === 'disabled' && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      const error = new Error('Gmail ' + response.status + (what ? ' al ' + what : '') + ': ' + problem.text);
      error.status = response.status;
      error.kind = problem.kind;
      throw error;
    }
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
