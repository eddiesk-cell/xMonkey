// Web tools: fetch a URL and extract readable text; search the web.
//
// Neither tool needs an API key to be useful:
//   web_fetch  does a plain HTTP GET, strips boilerplate, returns text.
//              Handles HTML, JSON, plain text and PDF-by-sniffing is out of
//              scope — but it returns an honest note instead of garbage.
//   web_search uses a configurable endpoint (SearXNG, Brave, Tavily, or a custom
//              JSON API). With none configured it fails with instructions rather
//              than pretending to search.

import { ToolError, clipOutput } from './registry.mjs';

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export function webTools(config = {}) {
  return [webFetchTool(), webSearchTool(config)];
}

// ---------------------------------------------------------------- fetch

function webFetchTool() {
  return {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its readable text. Use it for documentation, issues, and web pages. ' +
      'HTML is stripped to text; JSON is returned as-is (truncated).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        maxChars: { type: 'number', description: 'Maximum characters to return (default 20000).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    validate(input) {
      let u;
      try {
        u = new URL(String(input.url));
      } catch {
        return { ok: false, error: `not a valid URL: ${input.url}` };
      }
      if (!/^https?:$/.test(u.protocol)) {
        return { ok: false, error: `only http(s) URLs are supported (got ${u.protocol})` };
      }
      return { ok: true };
    },
    async run(input) {
      const url = String(input.url);
      const maxChars = Math.min(200000, Math.max(500, input.maxChars ?? 20000));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal: ac.signal,
          redirect: 'follow',
          headers: {
            'user-agent': 'xmonkey/1.0 (+https://github.com)',
            accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5',
          },
        });
        if (!res.ok) {
          throw new ToolError(`HTTP ${res.status} ${res.statusText} for ${url}`);
        }
        const type = res.headers.get('content-type') ?? '';
        const len = Number(res.headers.get('content-length') ?? 0);
        if (len > MAX_BYTES) {
          throw new ToolError(`${url} is ${(len / 1e6).toFixed(1)} MB; too large to fetch`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) {
          throw new ToolError(`${url} returned ${(buf.length / 1e6).toFixed(1)} MB; too large to fetch`);
        }
        const body = buf.toString('utf8');

        let text;
        if (/json/i.test(type) || /^\s*[{[]/.test(body.slice(0, 200))) {
          try {
            text = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            text = body;
          }
        } else if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body.slice(0, 200))) {
          text = htmlToText(body);
        } else if (/pdf/i.test(type)) {
          return { content: `[${url} is a PDF. Download it and read it with a local tool.]` };
        } else {
          text = body;
        }
        const header = `# ${url}\n\n`;
        return { content: clipOutput(header + text, maxChars) };
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw new ToolError(`could not fetch ${url}: ${err.message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Strip tags, scripts, styles and collapse whitespace, keeping block structure. */
export function htmlToText(html) {
  let s = String(html);
  // Remove non-content elements entirely.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Keep the title as a heading.
  const title = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  // Mark block boundaries so text does not run together.
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<h([1-6])[^>]*>/gi, (_m, n) => `${'#'.repeat(Number(n))} `);
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, '');
  // Decode the common entities.
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
  // Collapse whitespace but keep paragraph breaks.
  s = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  if (title) {
    const t = title[1].replace(/<[^>]+>/g, '').trim();
    if (t && !s.startsWith(`# ${t}`)) s = `# ${t}\n\n${s}`;
  }
  return s;
}

// ---------------------------------------------------------------- search

function webSearchTool(config) {
  return {
    name: 'web_search',
    description:
      'Search the web for current information. Requires a search endpoint configured as ' +
      'webSearch in xmonkey.config.json (SearXNG, Brave, Tavily, or a custom JSON API).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'number', description: 'Maximum results (default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async run(input) {
      const cfg = config.webSearch;
      if (!cfg?.endpoint) {
        throw new ToolError(
          'web_search has no endpoint configured. Add to xmonkey.config.json:\n' +
          '  "webSearch": { "kind": "searxng", "endpoint": "http://127.0.0.1:8080" }\n' +
          '  (also supported: kind "brave" or "tavily", with "apiKey")'
        );
      }
      const limit = Math.min(10, Math.max(1, input.limit ?? 5));
      const q = String(input.query);

      const headers = { accept: 'application/json' };
      let url;
      const kind = cfg.kind ?? 'searxng';
      if (kind === 'searxng') {
        url = `${cfg.endpoint.replace(/\/+$/, '')}/search?q=${encodeURIComponent(q)}&format=json&language=en`;
      } else if (kind === 'brave') {
        url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`;
        headers['x-subscription-token'] = cfg.apiKey ?? '';
      } else if (kind === 'tavily') {
        url = 'https://api.tavily.com/search';
        headers['content-type'] = 'application/json';
      } else if (kind === 'custom') {
        url = cfg.endpoint.replace('{query}', encodeURIComponent(q)).replace('{limit}', String(limit));
      } else {
        throw new ToolError(`unknown webSearch kind "${kind}"`);
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: kind === 'tavily' ? 'POST' : 'GET',
          headers,
          signal: ac.signal,
          body: kind === 'tavily'
            ? JSON.stringify({ api_key: cfg.apiKey, query: q, max_results: limit })
            : undefined,
        });
        if (!res.ok) throw new ToolError(`search endpoint returned HTTP ${res.status}`);
        const data = await res.json();
        const hits = normalizeResults(kind, data, limit);
        if (!hits.length) return { content: `No results for "${q}".` };
        return {
          content: hits
            .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet ?? ''}`.trim())
            .join('\n\n'),
        };
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw new ToolError(`search failed: ${err.message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Each backend nests results differently; flatten to {title,url,snippet}. */
export function normalizeResults(kind, data, limit) {
  const pick = (arr, map) => (Array.isArray(arr) ? arr.map(map).filter((h) => h.url).slice(0, limit) : []);
  switch (kind) {
    case 'searxng':
      return pick(data?.results, (r) => ({ title: r.title, url: r.url, snippet: r.content }));
    case 'brave':
      return pick(data?.web?.results, (r) => ({ title: r.title, url: r.url, snippet: r.description }));
    case 'tavily':
      return pick(data?.results, (r) => ({ title: r.title, url: r.url, snippet: r.content }));
    case 'custom':
      return pick(data?.results ?? data?.items ?? data?.data, (r) => ({
        title: r.title ?? r.name, url: r.url ?? r.link, snippet: r.snippet ?? r.description,
      }));
    default:
      return [];
  }
}
