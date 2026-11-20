import type { FunctionTool, Tool, WebSearchTool } from '../types.js';
import { AnyModelError } from '../types.js';

// The common `{ type: 'web_search' }` tool, translated per provider (specs/web-search-all-providers.md).

export function isWebSearchTool(tool: unknown): tool is WebSearchTool {
  return Boolean(tool && typeof tool === 'object' && (tool as WebSearchTool).type === 'web_search');
}

export function findWebSearchTool(tools: Tool[] | undefined): WebSearchTool | undefined {
  return tools?.find(isWebSearchTool);
}

/** A request with web search, refused where the provider has no search of its own. */
export function rejectWebSearch(tools: Tool[] | undefined, provider: string): void {
  if (findWebSearchTool(tools)) {
    throw new AnyModelError(400, `${provider} has no built-in web search; web_search can't be used with this provider`, { provider_name: provider });
  }
}

/** Anthropic and Perplexity take an allow list or a block list, never both (the API returns a 400). */
function oneDomainList(tool: WebSearchTool, provider: string): void {
  if (tool.filters?.allowed_domains?.length && tool.filters?.blocked_domains?.length) {
    throw new AnyModelError(400, `${provider} web search takes allowed_domains or blocked_domains, not both`, { provider_name: provider });
  }
}

/** Opus 4.6+, Sonnet 4.6+ and every later family take the dynamic-filtering version. Haiku
    stays on the basic one: Haiku 5.5 with web_search_20260209 answered without searching, and
    with web_search_20250305 searched (tested 2026-10-07). */
function anthropicTakesCurrentSearch(model: string): boolean {
  const id = model.replace(/^anthropic\//, '');
  if (/^claude-(fable|mythos)/.test(id)) return true;
  const m = id.match(/^claude-(opus|sonnet)-(\d+)(?:-(\d+))?/);
  if (!m) return false;
  const major = Number(m[2]), minor = Number(m[3] ?? 0);
  return major > 4 || (major === 4 && minor >= 6 && minor < 100);
}

/** Anthropic's web search server tool. `search_context_size` has no Anthropic equivalent. */
export function anthropicWebSearchTool(model: string, tool: WebSearchTool): Record<string, unknown> {
  oneDomainList(tool, 'anthropic');
  const out: Record<string, unknown> = {
    type: anthropicTakesCurrentSearch(model) ? 'web_search_20260209' : 'web_search_20250305',
    name: 'web_search',
  };
  if (tool.filters?.allowed_domains?.length) out.allowed_domains = tool.filters.allowed_domains;
  if (tool.filters?.blocked_domains?.length) out.blocked_domains = tool.filters.blocked_domains;
  return out;
}

/** Function tools and web search in Anthropic's shape; shared by the live and batch adapters. */
export function anthropicTools(model: string, tools: Tool[]): Record<string, unknown>[] {
  return tools.flatMap(t => {
    if (isWebSearchTool(t)) return [anthropicWebSearchTool(model, t)];
    if ((t as FunctionTool)?.type !== 'function') return [];
    const f = (t as FunctionTool).function;
    return [{ name: f.name, description: f.description || '', input_schema: f.parameters || { type: 'object', properties: {} } }];
  });
}

/** The pages Claude's searches returned, the ones its text cites first. With the
    dynamic-filtering search (web_search_20260209) Claude often reads results from code
    execution and its text carries no citations, so the search results are the record of
    what it consulted, as xAI's `citations` are. */
export function anthropicCitations(content: unknown[]): { url: string; title?: string }[] {
  const seen = new Map<string, { url: string; title?: string }>();
  const add = (url: unknown, title: unknown) => {
    if (typeof url === 'string' && url && !seen.has(url)) seen.set(url, { url, ...(typeof title === 'string' && title ? { title } : {}) });
  };
  for (const block of content as any[]) {
    for (const c of block?.type === 'text' ? block.citations ?? [] : []) {
      if (c?.type === 'web_search_result_location') add(c.url, c.title);
    }
  }
  for (const block of content as any[]) {
    if (block?.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const r of block.content) if (r?.type === 'web_search_result') add(r.url, r.title);
  }
  return [...seen.values()];
}

/** Gemini's tools: function declarations, and Google Search for web_search. Google Search
    takes no domain filters, so a request with them is refused rather than run unfiltered. */
export function geminiTools(tools: Tool[]): Record<string, unknown>[] {
  const functions = tools.filter((t): t is FunctionTool => (t as FunctionTool)?.type === 'function');
  const search = findWebSearchTool(tools);
  if (search?.filters?.allowed_domains?.length || search?.filters?.blocked_domains?.length) {
    throw new AnyModelError(400, 'Google Search grounding has no domain filters', { provider_name: 'google' });
  }
  const out: Record<string, unknown>[] = [];
  if (functions.length) {
    out.push({ functionDeclarations: functions.map(t => ({
      name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || {},
    })) });
  }
  if (search) out.push({ googleSearch: {} });
  return out;
}

/** The pages a Gemini answer was grounded on. */
export function geminiCitations(candidate: any): { url: string; title?: string }[] {
  return (candidate?.groundingMetadata?.groundingChunks ?? [])
    .filter((c: any) => c?.web?.uri)
    .map((c: any) => ({ url: c.web.uri, ...(c.web.title ? { title: c.web.title } : {}) }));
}

/** Perplexity's Sonar models search by default: web_search is not sent as a tool, and its
    domain filters become search_domain_filter (allow as-is, block with a "-" prefix). */
export function perplexitySearch(tools: Tool[] | undefined): { tools?: Tool[]; search_domain_filter?: string[] } {
  if (!tools) return {};
  const search = findWebSearchTool(tools);
  const rest = tools.filter(t => !isWebSearchTool(t));
  const out: { tools?: Tool[]; search_domain_filter?: string[] } = rest.length ? { tools: rest } : {};
  if (!search) return { tools };
  oneDomainList(search, 'perplexity');
  const filter = [...(search.filters?.allowed_domains ?? []), ...(search.filters?.blocked_domains ?? []).map(d => `-${d}`)];
  if (filter.length) out.search_domain_filter = filter;
  return out;
}
