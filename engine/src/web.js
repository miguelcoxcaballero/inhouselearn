// Internet: buscar (web_search) y leer una página (web_fetch). El navegador no
// puede llamar a un buscador directamente (CORS), así que la app hace la
// búsqueda con la clave de OpenRouter del usuario (su búsqueda web, Exa) y lee
// las páginas a través de un lector con CORS. Cada resultado vuelve con su
// título y su URL para que el modelo cite y la app enseñe las fuentes.
//
// ctx: { search(query, { maxResults, domains }) → { results: [{ title, url, snippet }], digest },
//   fetchPage(url) → { title, url, text } }
import { Type } from '@earendil-works/pi-ai';

const MAX_PAGE_CHARS = 30000;

function textResult(text, details) {
  return { content: [{ type: 'text', text }], details: details || {} };
}

const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };

export function createWebTools(ctx) {
  return [
    {
      name: 'web_search',
      label: 'Buscar en internet',
      description: 'Search the internet for anything current or that you do not know for sure: news, prices, versions, what people say on Reddit or forums, documentation. Returns the results with title, URL and an excerpt. Search with a few precise words (add site:reddit.com or similar to stay on one site); search again with other words if the first results are not enough, and open the best pages with web_fetch when you need their full text. Then answer and cite each fact with a Markdown link to the page it comes from, e.g. [The Verge](https://…).',
      parameters: Type.Object({
        query: Type.String({ description: 'What to search, a few precise words. "site:reddit.com" etc. works.' }),
        max_results: Type.Optional(Type.Number({ description: 'How many results (default 6, max 10).' }))
      }),
      execute: async (id, params) => {
        const query = String(params.query || '').trim();
        if (!query) throw new Error('Falta qué buscar.');
        const found = await ctx.search(query, { maxResults: Math.min(10, Math.max(1, Number(params.max_results) || 6)) });
        const results = (found.results || []).filter((item) => item && /^https?:\/\//.test(item.url || ''));
        if (!results.length) return textResult('No he encontrado nada para «' + query + '»' + (found.digest ? '.\n\n' + found.digest : '. Prueba con otras palabras.'), { query, sources: [] });
        const lines = results.map((item, index) => '[' + (index + 1) + '] ' + (item.title || host(item.url)) + '\n' + item.url + (item.snippet ? '\n' + String(item.snippet).replace(/\s+/g, ' ').slice(0, 700) : ''));
        return textResult('Resultados de internet para «' + query + '»:\n\n' + lines.join('\n\n') + (found.digest ? '\n\nResumen del buscador:\n' + found.digest : '') + '\n\nCita cada dato con un enlace Markdown a su página.', {
          query,
          sources: results.map((item) => ({ title: item.title || host(item.url), url: item.url }))
        });
      }
    },
    {
      name: 'web_fetch',
      label: 'Leer una página web',
      description: 'Read the full text of a web page (an article, a Reddit thread, documentation) as Markdown. Use it on the best results of web_search, or on a link the user gives you. Long pages are read in parts with from.',
      parameters: Type.Object({
        url: Type.String({ description: 'The page, https://…' }),
        from: Type.Optional(Type.Number({ description: 'Character to start at, for long pages.' }))
      }),
      execute: async (id, params) => {
        const url = String(params.url || '').trim();
        if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error('Pasa una dirección http(s) completa.');
        const page = await ctx.fetchPage(url);
        const start = Math.max(0, Math.floor(Number(params.from) || 0));
        const text = String(page.text || '');
        const part = text.slice(start, start + MAX_PAGE_CHARS);
        const rest = text.length - start - part.length;
        return textResult((page.title ? page.title + '\n' : '') + url + '\n\n' + (part || '(La página no tiene texto que pueda leer.)') + (rest > 0 ? '\n… (quedan ' + rest + ' caracteres: vuelve a leer con from=' + (start + part.length) + ')' : ''), {
          sources: [{ title: page.title || host(url), url }]
        });
      }
    }
  ];
}
