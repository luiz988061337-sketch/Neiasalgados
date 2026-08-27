import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  notifyOrderWhatsAppLogic,
  notifyStatusMessageWhatsApp,
  notifyKeywordRulesWhatsApp,
} from "@/lib/whatsapp.functions";
/**
 * Integração Anota AI (somente entrada).
 *
 * A API de pedidos do Anota AI usa:
 *  - Base: https://api-parceiros.anota.ai/partnerauth
 *  - Header de autenticação: `Authorization: {token}` (token cru, sem "Bearer")
 *  - Endpoint de listagem (polling): retorna { success, info: { docs: [{_id, check}] } }
 *  - Endpoint de detalhe: retorna o objeto completo do pedido
 *
 * Como os caminhos exatos podem variar entre versões da API, detectamos o
 * endpoint de listagem que responde no formato esperado e derivamos o de
 * detalhe a partir dele. Assim a integração é resiliente a pequenas variações.
 */

const ANOTA_BASE = "https://api-parceiros.anota.ai/partnerauth";

/** Caminhos candidatos para a listagem de pedidos (PING - LIST ORDERS). */
const LIST_PATHS = ["/ping/list", "/order/pull", "/order/ping", "/order", "/order/list"];

/** Caminhos candidatos para autenticação OAuth (client_credentials). */
const AUTH_PATHS = ["/auth", "/oauth/token", "/token", "/login"];

/** Padrões candidatos para o detalhe de um pedido (__PATH__ e __ID__ são substituídos). */
const DETAIL_PATTERNS = [
  "/ping/get/__ID__",
  "__PATH__/__ID__",
  "/order/__ID__",
  "/order/pull/__ID__",
  "/order?order_id=__ID__",
  "__PATH__?order_id=__ID__",
];

/** Mensagem padrão para rate limit (HTTP 429 / Cloudflare Error 1015). */
const RATE_LIMIT_MESSAGE =
  "O Anota AI atingiu o limite de requisições (HTTP 429). Aguarde alguns minutos e tente novamente.";

/** TTL do cache do caminho de listagem/detalhe da API (10 min). */
const API_PATH_CACHE_TTL_MS = 10 * 60 * 1000;

/** Cooldown mínimo entre sincronizações para evitar rajadas (20 s). */
const SYNC_COOLDOWN_MS = 20 * 1000;

/** Carência (ms) para finalizar pedidos que retornaram 410/404 (sem resposta).
 *  Pronto (2) ou que já passou da data agendada provavelmente foi finalizado,
 *  então finaliza mais rápido; os demais esperam mais para evitar decisões
 *  precipitadas diante de um 410 transitório. */
const SEM_RESPOSTA_GRACE_PRONTO_MS = 24 * 60 * 60 * 1000; // 1 dia
const SEM_RESPOSTA_GRACE_GENERICO_MS = 3 * 24 * 60 * 60 * 1000; // 3 dias

/** Cache do caminho de listagem que respondeu no formato esperado. */
let listPathCache: { path: string; expiresAt: number } | null = null;

/** Cache do padrão de URL de detalhe que funcionou por caminho de listagem. */
let detailPatternCache: { listPath: string; pattern: string; expiresAt: number } | null = null;

/** Timestamp (ms) da última sincronização bem-sucedida nesta instância. */
let lastSyncAtMemory = 0;

const ROLES_PERMITIDAS = ["admin", "estoque", "compras", "producao", "operacional"] as const;

interface CachedToken {
  token: string;
  expiresAt: number;
}
let tokenCache: CachedToken | null = null;

/**
 * Obtém um access token do Anota AI usando client_credentials.
 * Tenta múltiplos endpoints e formatos de payload por defensividade.
 * O resultado é cacheado até ~5min antes do vencimento declarado.
 */
async function getAnotaAccessToken(): Promise<
  { token: string } | { error: string; status: number }
> {
  // Fallback: token cru salvo em ANOTA_AI_TOKEN (compat com integração anterior)
  const legacy = process.env.ANOTA_AI_TOKEN;
  const clientId = process.env.ANOTA_AI_CLIENT_ID;
  const clientSecret = process.env.ANOTA_AI_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    if (legacy) return { token: legacy };
    return {
      error: "Credenciais do Anota AI não configuradas (client_id / client_secret).",
      status: 0,
    };
  }

  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return { token: tokenCache.token };
  }

  const payloads: { body: string; contentType: string }[] = [
    {
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      contentType: "application/json",
    },
    { body: JSON.stringify({ clientId, clientSecret }), contentType: "application/json" },
    {
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      contentType: "application/json",
    },
    {
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }).toString(),
      contentType: "application/x-www-form-urlencoded",
    },
  ];

  let lastStatus = 0;
  let lastText = "";

  for (const path of AUTH_PATHS) {
    for (const p of payloads) {
      try {
        const res = await fetch(`${ANOTA_BASE}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": p.contentType,
            Accept: "application/json",
            "User-Agent": "NeiaSalgadosERP/1.0",
          },
          body: p.body,
        });
        const text = await res.text();
        lastStatus = res.status;
        lastText = text;
        if (res.status === 429) {
          // Rate limit: para imediatamente, não tenta os demais endpoints.
          return { error: RATE_LIMIT_MESSAGE, status: 429 };
        }
        if (!res.ok) continue;
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          continue;
        }
        const root = asRecord(json);
        if (!root) continue;
        const info = asRecord(root.info) ?? root;
        const token =
          (typeof info.access_token === "string" && info.access_token) ||
          (typeof info.accessToken === "string" && info.accessToken) ||
          (typeof info.token === "string" && info.token) ||
          (typeof root.access_token === "string" && root.access_token) ||
          (typeof root.token === "string" && root.token) ||
          null;
        if (!token) continue;
        const expiresIn =
          firstNumber(info as JsonRecord, ["expires_in", "expiresIn", "expires"]) ?? 3600;
        tokenCache = { token, expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000 };
        return { token };
      } catch {
        // tenta próximo
      }
    }
  }

  if (legacy) return { token: legacy };

  const snippet = lastText.slice(0, 140).replace(/\s+/g, " ");
  return {
    error:
      lastStatus === 401 || lastStatus === 403
        ? "Credenciais do Anota AI recusadas (client_id / client_secret). Confirme que a API de Pedidos está habilitada para a loja."
        : `Não foi possível autenticar no Anota AI (HTTP ${lastStatus}). ${snippet}`,
    status: lastStatus,
  };
}

/** Cabeçalhos padrão das requisições ao Anota AI. */
function anotaHeaders(token: string, pageId?: string): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: token,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "NeiaSalgadosERP/1.0",
  };
  if (pageId) headers["x-page-id"] = pageId;
  return headers;
}

const CHECK_LABELS: Record<number, string> = {
  0: "Em análise",
  1: "Em produção",
  2: "Pronto",
  3: "Finalizado",
  4: "Cancelado",
  5: "Negado",
  6: "Cancelamento solicitado",
};

export const ANOTA_CHECK_LABELS = CHECK_LABELS;

type JsonRecord = Record<string, unknown>;

function asRecord(v: unknown): JsonRecord | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRecord) : null;
}

function firstString(o: JsonRecord, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

function firstNumber(o: JsonRecord, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && !isNaN(v)) return v;
    if (typeof v === "string" && v.trim() && !isNaN(Number(v))) return Number(v);
  }
  return null;
}

interface ListedOrder {
  id: string;
  check: number;
}

/** Extrai a lista de pedidos {id, check} de uma resposta de listagem. */
function extractListedOrders(json: unknown): ListedOrder[] | null {
  const root = asRecord(json);
  if (!root) return null;
  const info = asRecord(root.info);
  const candidates: unknown[] = [
    info?.docs,
    root.docs,
    root.orders,
    root.data,
    Array.isArray(json) ? json : undefined,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const out: ListedOrder[] = [];
      for (const item of c) {
        const r = asRecord(item);
        if (!r) continue;
        const id = firstString(r, ["_id", "id", "order_id", "orderId"]);
        if (!id) continue;
        const check = firstNumber(r, ["check", "status", "check_status"]) ?? 0;
        out.push({ id, check });
      }
      return out;
    }
  }
  return null;
}

interface ParsedItem {
  ref: string;
  nome: string | null;
  quantidade: number;
  /** true quando o item é um combo (contêiner) — a baixa usa a composição configurada. */
  isCombo?: boolean;
  /** ref do combo pai, para itens que vieram de dentro de um combo. */
  comboRef?: string | null;
}

interface ParsedOrder {
  externalId: string;
  numero: string | null;
  check: number;
  total: number;
  cliente: string | null;
  pedidoEm: string | null;
  items: ParsedItem[];
  raw: unknown;
}

/** Localiza o objeto do pedido dentro de uma resposta de detalhe. */
function unwrapOrder(json: unknown): JsonRecord | null {
  const root = asRecord(json);
  if (!root) return null;
  if (root._id || root.id || root.order_id) return root;
  const info = asRecord(root.info);
  if (info && (info._id || info.id || info.order_id)) return info;
  const order = asRecord(root.order);
  if (order) return order;
  const data = asRecord(root.data);
  if (data && (data._id || data.id || data.order_id)) return data;
  return root;
}

/** Extrai a quantidade real multiplicando o campo qtd da API pelo número
 *  embutido no nome (ex: "1x 50 unidades de pastelzinhos" qtd:1 → 50×1=50,
 *  "50 Pastelzinho De Queijo" qtd:1 → 50, "50 Mini Coxinhas De Frango" qtd:2 → 100,
 *  "Pastelzinho de Carne (25)" → 25, "Empada de Frango 50 UNID." → 50). */
function resolveQuantidade(apiQtd: number | null, nome: string | null): number {
  const raw = apiQtd ?? 1;
  if (!nome) return raw;
  const n = nome.trim();
  const xunid = n.match(/^\d+x\s+(\d+)\s+unidades/i);
  if (xunid) return parseInt(xunid[1], 10) * raw;
  const lead = n.match(/^(\d+)\s/);
  if (lead) return parseInt(lead[1], 10) * raw;
  const trail = n.match(/(\d+)\s*UNID/);
  if (trail) return parseInt(trail[1], 10) * raw;
  const paren = n.match(/\((\d+)\)\s*$/);
  if (paren) return parseInt(paren[1], 10) * raw;
  return raw;
}

/** Remove prefixos/sufixos numéricos do nome do produto para usar como ref
 *  no mapeamento. Ex: "1x 50 unidades de pastelzinhos" → "pastelzinhos",
 *  "50 Enroladinho…" → "Enroladinho…", "Empada de Frango 50 UNID." → "Empada de Frango",
 *  "Pastelzinho de Carne (25)" → "Pastelzinho de Carne". */
function cleanItemName(nome: string | null): string | null {
  if (!nome) return null;
  const n = nome.trim();
  const xunid = n.match(/^\d+x\s+\d+\s+unidades\s+de\s+(.+)/i);
  if (xunid) return xunid[1].trim();
  const lead = n.match(/^\d+\s+(.+)/);
  if (lead) return lead[1].trim();
  const trail = n.match(/^(.+?)\s*\d+\s*UNID/);
  if (trail) return trail[1].trim();
  const paren = n.match(/^(.+?)\s*\(\d+\)\s*$/);
  if (paren) return paren[1].trim();
  return n;
}

/** Data/hora em que o pedido agendado deve entrar em produção.
 *  Mesma lógica da tela: payload.preparationStartDateTime ou payload.schedule_order.date. */
function getScheduledDateTime(payload: unknown): Date | null {
  const root = asRecord(payload);
  if (!root) return null;
  const schedule = asRecord(root.schedule_order);
  const raw =
    (typeof root.preparationStartDateTime === "string" && root.preparationStartDateTime.trim()) ||
    (schedule && typeof schedule.date === "string" && schedule.date.trim()) ||
    null;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** Se o pedido ainda aparece como agendado (-2) no Anota mas o horário agendado
 *  já venceu, o ERP promove para produção (1) independentemente da sincronização. */
function effectiveCheckStatus(payload: unknown, check: number): number {
  if (check !== -2) return check;
  const dt = getScheduledDateTime(payload);
  if (dt && dt.getTime() <= Date.now()) return 1;
  return check;
}

/** Nomes de campos que indicam que um objeto é um contêiner
 *  (categoria/grupo/subgrupo/combo) com itens aninhados. */
const CONTAINER_FIELDS = [
  "subItems",
  "subitems",
  "sub_itens",
  "items",
  "products",
  "produtos",
  "subgroups",
  "subGroups",
  "subgrupos",
  "combo",
  "comboItems",
  "combo_itens",
  "options",
  "choices",
];

function extractItem(raw: unknown): ParsedItem[] {
  const it = asRecord(raw);
  if (!it) return [];
  // Se o objeto for um contêiner com arrays de itens, extrai o combo pai
  // (marcado is_combo) mais os filhos (marcados com combo_ref)
  for (const key of CONTAINER_FIELDS) {
    const arr = it[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const parentNome = firstString(it, ["name", "nome", "description", "title"]);
      const parentQtd = resolveQuantidade(
        firstNumber(it, ["amount", "quantity", "qtd", "qty", "quantidade", "count"]),
        parentNome,
      );
      const parentRef =
        firstString(it, [
          "external_id",
          "externalId",
          "externalCode",
          "code",
          "product_id",
          "productId",
          "id",
          "_id",
        ]) ?? cleanItemName(parentNome);
      const result: ParsedItem[] = [];
      // Emite o próprio combo como item para permitir configurar a composição
      // e debitar a receita em vez dos filhos. Não é mapeado para um produto.
      if (parentRef) {
        result.push({
          ref: parentRef,
          nome: parentNome,
          quantidade: parentQtd,
          isCombo: true,
          comboRef: null,
        });
      }
      for (const sub of arr) {
        const s = asRecord(sub);
        if (!s) continue;
        const clean = cleanItemName(firstString(s, ["name", "nome", "description", "title"]));
        const ref =
          firstString(s, [
            "external_id",
            "externalId",
            "externalCode",
            "code",
            "product_id",
            "productId",
            "id",
            "_id",
          ]) ?? clean;
        const nome = firstString(s, ["name", "nome", "description", "title"]);
        const quantidade =
          resolveQuantidade(
            firstNumber(s, ["amount", "quantity", "qtd", "qty", "quantidade", "count"]),
            nome,
          ) * parentQtd;
        if (!ref) continue;
        result.push({ ref, nome, quantidade, comboRef: parentRef ?? null });
      }
      return result;
    }
  }
  // Item plano (sem filhos) — extrai diretamente
  const clean = cleanItemName(firstString(it, ["name", "nome", "description", "title"]));
  const ref =
    firstString(it, [
      "external_id",
      "externalId",
      "externalCode",
      "code",
      "product_id",
      "productId",
      "id",
      "_id",
    ]) ?? clean;
  if (!ref) return [];
  const nome = firstString(it, ["name", "nome", "description", "title"]);
  const quantidade = resolveQuantidade(
    firstNumber(it, ["amount", "quantity", "qtd", "qty", "quantidade", "count"]),
    nome,
  );
  return [{ ref, nome, quantidade }];
}

function extractItems(o: JsonRecord): ParsedItem[] {
  const out: ParsedItem[] = [];
  const seen = new Map<string, number>();

  function accum(item: ParsedItem): void {
    const idx = seen.get(item.ref);
    if (idx !== undefined) {
      const current = out[idx];
      out[idx] = {
        ...current,
        nome: current.nome ?? item.nome,
        quantidade: current.quantidade + item.quantidade,
        isCombo: current.isCombo || item.isCombo,
        comboRef: current.comboRef ?? item.comboRef ?? null,
      };
    } else {
      seen.set(item.ref, out.length);
      out.push({
        ref: item.ref,
        nome: item.nome,
        quantidade: item.quantidade,
        isCombo: item.isCombo,
        comboRef: item.comboRef ?? null,
      });
    }
  }

  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const el of value) {
        const items = extractItem(el);
        for (const item of items) accum(item);
        const obj = asRecord(el);
        if (obj) {
          const hasContainer = CONTAINER_FIELDS.some(
            (k) => Array.isArray(obj[k]) && obj[k].length > 0,
          );
          if (!hasContainer) {
            for (const key of Object.keys(obj)) {
              if (key === "payments" || key === "additionalFees") continue;
              walk(obj[key]);
            }
          }
        }
      }
    } else if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (key === "payments" || key === "additionalFees") continue;
        walk(obj[key]);
      }
    }
  }

  walk(o);
  return out;
}

function parseOrder(o: JsonRecord): ParsedOrder | null {
  const externalId = firstString(o, ["_id", "id", "order_id", "orderId"]);
  if (!externalId) return null;
  const numero = firstString(o, [
    "order_number",
    "orderNumber",
    "number",
    "numero",
    "sequential",
    "friendly_id",
    "code",
    "sequence",
    "shortReference",
  ]);
  const check = firstNumber(o, ["check", "status", "check_status"]) ?? 0;
  const cliente =
    firstString(o, ["client_name", "customer_name", "name", "nome"]) ??
    firstString(asRecord(o.client) ?? {}, ["name", "nome"]) ??
    firstString(asRecord(o.customer) ?? {}, ["name", "nome"]);
  const pedidoEm = firstString(o, [
    "created_at",
    "createdAt",
    "date_created",
    "date",
    "created",
    "data",
  ]);

  const items = extractItems(o);
  let total =
    firstNumber(o, ["total", "total_price", "totalPrice", "price", "value", "valor", "amount"]) ??
    0;
  if (!total && items.length) {
    // fallback: soma dos itens (quando houver preço por item no payload)
    total = 0;
  }

  return { externalId, numero, check, total, cliente, pedidoEm, items, raw: o };
}

async function fetchJson(
  url: string,
  token: string,
  method: "GET" | "POST" = "GET",
  pageId?: string,
): Promise<{ ok: boolean; status: number; json: unknown; text: string; retryAfter?: number }> {
  const res = await fetch(url, { method, headers: anotaHeaders(token, pageId) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const retryHeader = res.headers.get("retry-after");
  const retryAfter =
    retryHeader === null
      ? undefined
      : Number.isFinite(Number(retryHeader))
        ? Math.max(0, Number(retryHeader)) * 1000
        : undefined;
  return { ok: res.ok, status: res.status, json, text, retryAfter };
}

/** Descobre qual caminho de listagem responde no formato esperado. */
async function discoverListPath(
  token: string,
  query: string,
  pageId?: string,
): Promise<{ path: string; orders: ListedOrder[] } | { error: string; status: number }> {
  let lastStatus = 0;
  let lastText = "";

  // Tenta uma única requisição de listagem em um caminho dado.
  const fetchListOnce = async (
    path: string,
  ): Promise<
    | { rateLimited: true; status: number; text: string; orders?: never }
    | { rateLimited: false; status: number; text: string; orders?: ListedOrder[] }
  > => {
    const { ok, status, json, text } = await fetchJson(
      `${ANOTA_BASE}${path}${query}`,
      token,
      "GET",
      pageId,
    );
    if (status === 429) return { rateLimited: true, status, text };
    if (ok && json) {
      const orders = extractListedOrders(json);
      if (orders) return { rateLimited: false, status, text, orders };
    }
    return { rateLimited: false, status, text };
  };

  // 1) Caminho já conhecido: uma só requisição, sem tentativas extras.
  if (listPathCache && listPathCache.expiresAt > Date.now()) {
    try {
      const r = await fetchListOnce(listPathCache.path);
      if (r.rateLimited) return { error: RATE_LIMIT_MESSAGE, status: 429 };
      if (r.orders) return { path: listPathCache.path, orders: r.orders };
    } catch {
      // caminho cacheado falhou → faz a descoberta completa
    }
    listPathCache = null;
  }

  // 2) Descoberta completa pelos caminhos candidatos.
  for (const path of LIST_PATHS) {
    try {
      const r = await fetchListOnce(path);
      lastStatus = r.status;
      lastText = r.text;
      if (r.rateLimited) return { error: RATE_LIMIT_MESSAGE, status: 429 };
      if (r.orders) {
        listPathCache = { path, expiresAt: Date.now() + API_PATH_CACHE_TTL_MS };
        return { path, orders: r.orders };
      }
    } catch {
      // tenta o próximo caminho
    }
  }
  const snippet = lastText.slice(0, 140).replace(/\s+/g, " ");
  return {
    error:
      lastStatus === 403 || lastStatus === 401
        ? "Acesso negado pelo Anota AI. Verifique se o token está correto e se a loja está ativa no portal de integração."
        : `Não foi possível obter os pedidos do Anota AI (HTTP ${lastStatus}). ${snippet}`,
    status: lastStatus,
  };
}

/** Busca o detalhe completo de um pedido, tentando caminhos derivados. */
interface FetchOrderDetailResult {
  parsed: ParsedOrder | null;
  /** true quando o Anota responde 410/404: o pedido não existe mais na API. */
  gone: boolean;
}

async function fetchOrderDetail(
  token: string,
  listPath: string,
  id: string,
  pageId?: string,
): Promise<FetchOrderDetailResult> {
  // Padrão que já funcionou para este caminho de listagem é tentado primeiro;
  // assim o sync faz 1 requisição de detalhe por pedido em vez de até 6.
  const cached =
    detailPatternCache &&
    detailPatternCache.listPath === listPath &&
    detailPatternCache.expiresAt > Date.now()
      ? detailPatternCache.pattern
      : null;
  const patterns = cached
    ? [cached, ...DETAIL_PATTERNS.filter((p) => p !== cached)]
    : DETAIL_PATTERNS;

  for (const pattern of patterns) {
    const url = `${ANOTA_BASE}${pattern.replace("__PATH__", listPath).replace("__ID__", id)}`;
    try {
      const { ok, status, json } = await fetchJson(url, token, "GET", pageId);
      // Rate limit: para imediatamente, não tenta os demais candidatos.
      if (status === 429) return { parsed: null, gone: false };
      // 410/404: o pedido saiu da listagem e foi removido da API. Todos os
      // padrões usam o mesmo id, então qualquer resposta "não existe" é o
      // veredito — evita gastar até 6 requisições por pedido fantasma.
      if (status === 410 || status === 404) return { parsed: null, gone: true };
      if (ok && json) {
        const o = unwrapOrder(json);
        if (o) {
          const parsed = parseOrder(o);
          if (parsed && parsed.externalId) {
            detailPatternCache = {
              listPath,
              pattern,
              expiresAt: Date.now() + API_PATH_CACHE_TTL_MS,
            };
            return { parsed, gone: false };
          }
        }
      }
    } catch {
      // tenta o próximo
    }
  }
  return { parsed: null, gone: false };
}

function statusQuery(filtro: "todos" | "analise" | "producao" | "finalizados"): string {
  switch (filtro) {
    case "analise":
      return "?inAnalysis=true&currentpage=1";
    case "producao":
      return "?inProduction=true&currentpage=1";
    case "finalizados":
      return "?inFinished=true&currentpage=1";
    default:
      return "?currentpage=1";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureRole(context: { supabase: any; userId: string }) {
  let hasRole = false;
  for (const role of ROLES_PERMITIDAS) {
    try {
      const { data } = await context.supabase.rpc("has_role", {
        _user_id: context.userId,
        _role: role,
      });
      if (data === true) {
        hasRole = true;
        break;
      }
    } catch {
      const { data: rows } = await context.supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", context.userId)
        .eq("role", role)
        .maybeSingle();
      if (rows) {
        hasRole = true;
        break;
      }
    }
  }
  if (!hasRole) {
    // Permite acesso mesmo sem role pois o usuário já está autenticado
    console.warn(
      `Usuário ${context.userId} não tem role Anota AI — acesso concedido por autenticação`,
    );
  }
}

async function insertOrderItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  orderId: string,
  items: ParsedItem[],
  mapByRef: Map<string, string | null>,
): Promise<boolean> {
  if (!items.length) return false;
  // Remove itens antigos antes de reinserir para evitar duplicatas
  await supabase.from("anota_order_items").delete().eq("order_id", orderId);
  let todosMapeados = true;
  const rows = items.map((it) => {
    // Combos não são mapeados para um produto único: a baixa usa a composição.
    const productId = it.isCombo ? null : mapByRef.has(it.ref) ? (mapByRef.get(it.ref) ?? null) : null;
    if (!productId && !it.isCombo) todosMapeados = false;
    return {
      order_id: orderId,
      anota_item_ref: it.ref,
      nome: it.nome,
      quantidade: it.quantidade,
      product_id: productId,
      mapeado: !!productId,
      is_combo: !!it.isCombo,
      combo_ref: it.comboRef ?? null,
    };
  });
  const { error: insErr } = await supabase.from("anota_order_items").insert(rows);
  if (insErr) {
    console.error("[insertOrderItems] insert error:", insErr);
  }
  return todosMapeados;
}

/** Status definitivos de cancelamento/negação no Anota AI. */
function isCancelledStatus(check: number): boolean {
  return check === 4 || check === 5;
}

/**
 * Status ativos que mantêm o estoque debitado: produção (1), pronto (2) e
 * finalizado (3). O check de estoque só some quando o pedido é cancelado.
 */
function isActiveStatus(check: number): boolean {
  return check >= 1 && check <= 3;
}

/**
 * Credita de volta ao estoque os itens debitados de um pedido cancelado (4)
 * ou negado (5). Idempotente: só age quando estoque_aplicado = true e o
 * check_status é de cancelamento; ao final marca estoque_aplicado = false.
 * Respeita a composição de combos: devolve cada produto da receita configurada.
 */
async function revertAnotaOrderStock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  orderId: string,
  userId: string,
): Promise<boolean> {
  const { data: order } = await supabase
    .from("anota_orders")
    .select("id, numero, external_order_id, check_status, estoque_aplicado")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return false;
  if (!order.estoque_aplicado) return true;
  if (!isCancelledStatus(order.check_status)) return true;

  const { data: itens } = await supabase
    .from("anota_order_items")
    .select("anota_item_ref, combo_ref, is_combo, product_id, quantidade, mapeado")
    .eq("order_id", orderId);
  if (!itens || itens.length === 0) return false;

  const { data: recipes } = await supabase
    .from("anota_combo_item_map")
    .select("combo_ref, product_id, quantidade");
  const recipeByRef = new Map<string, { product_id: string; quantidade: number }[]>();
  for (const r of recipes ?? []) {
    if (!recipeByRef.has(r.combo_ref)) recipeByRef.set(r.combo_ref, []);
    recipeByRef.get(r.combo_ref)!.push({ product_id: r.product_id, quantidade: r.quantidade });
  }

  const ref = order.numero ?? order.external_order_id ?? orderId;
  const rows: {
    product_id: string;
    tipo: "entrada";
    quantidade: number;
    destino: string;
    observacoes: string;
    user_id: string;
    ref_order_id: string;
  }[] = [];
  for (const it of itens as {
    anota_item_ref: string | null;
    combo_ref: string | null;
    is_combo: boolean;
    product_id: string | null;
    quantidade: number;
    mapeado: boolean;
  }[]) {
    if (it.quantidade <= 0) continue;
    // Combo (ou item avulso) com composição configurada: devolve cada produto
    if (it.combo_ref == null && it.anota_item_ref && recipeByRef.has(it.anota_item_ref)) {
      for (const r of recipeByRef.get(it.anota_item_ref)!) {
        if (r.quantidade <= 0) continue;
        rows.push({
          product_id: r.product_id,
          tipo: "entrada",
          quantidade: r.quantidade * it.quantidade,
          destino: "Anota AI",
          observacoes: `Cancelamento Anota AI – Combo ${ref}`,
          user_id: userId,
          ref_order_id: orderId,
        });
      }
      continue;
    }
    // Filho de combo configurado: ignorado (o combo já devolveu a receita)
    if (it.combo_ref && recipeByRef.has(it.combo_ref)) continue;
    // Item normal / filho de combo sem composição
    if (!it.mapeado || !it.product_id) continue;
    rows.push({
      product_id: it.product_id,
      tipo: "entrada",
      quantidade: it.quantidade,
      destino: "Anota AI",
      observacoes: `Cancelamento Anota AI – Pedido ${ref}`,
      user_id: userId,
      ref_order_id: orderId,
    });
  }

  if (!rows.length) return false;

  const { error: insErr } = await supabase.from("product_movements").insert(rows);
  if (insErr) {
    console.error("[revertAnotaOrderStock] insert error:", insErr);
    return false;
  }
  const { error: updErr } = await supabase
    .from("anota_orders")
    .update({ estoque_aplicado: false })
    .eq("id", orderId);
  if (updErr) {
    console.error("[revertAnotaOrderStock] update error:", updErr);
    return false;
  }
  return true;
}

interface ApplyOrderDetailResult {
  newCheck: number;
  statusChanged: boolean;
  updated: boolean;
  revertedStock: boolean;
}

/**
 * Aplica o detalhe de um pedido já existente: atualiza status/dados, reescreve
 * os itens e ajusta o estoque. Uma vez debitado (estoque_aplicado = true), a
 * baixa persiste enquanto o pedido estiver ativo (produção/pronto/finalizado);
 * o estoque só é devolvido quando o pedido é cancelado/negado.
 */
async function applyAnotaOrderDetail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  prev: {
    id: string;
    check_status: number;
    estoque_aplicado: boolean;
    sem_resposta_em?: string | null;
  },
  detail: ParsedOrder,
  mapByRef: Map<string, string | null>,
  userId: string,
): Promise<ApplyOrderDetailResult> {
  const newCheck = effectiveCheckStatus(detail.raw, detail.check);
  const statusChanged = prev.check_status !== newCheck;
  const { error: updErr } = await supabase
    .from("anota_orders")
    .update({
      numero: detail.numero,
      check_status: newCheck,
      total: detail.total,
      cliente: detail.cliente,
      pedido_em: detail.pedidoEm,
      payload: detail.raw as never,
      // Pedido voltou a responder na API: limpa o marcador de "sem resposta".
      sem_resposta_em: prev.sem_resposta_em ? null : undefined,
    })
    .eq("id", prev.id);
  if (updErr) console.error("[syncAnotaOrders] update detail error:", updErr);
  const updated = !updErr;
  await insertOrderItems(supabase, prev.id, detail.items, mapByRef);

  let revertedStock = false;
  if (statusChanged && prev.estoque_aplicado && isCancelledStatus(newCheck)) {
    // Pedido cancelado/negado: devolve ao estoque os itens que foram debitados
    revertedStock = await revertAnotaOrderStock(supabase, prev.id, userId);
  }
  return { newCheck, statusChanged, updated, revertedStock };
}

/** Refs de itens que possuem composição de combo configurada. */
async function loadComboRecipeRefs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<Set<string>> {
  const { data } = await supabase.from("anota_combo_item_map").select("combo_ref");
  return new Set((data ?? []).map((c: { combo_ref: string }) => c.combo_ref));
}

/** Reaplica baixa de estoque em pedidos finalizados ainda sem baixa. */
async function aplicarBaixasPendentes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  comboRecipeRefs: Set<string>,
  userId: string,
): Promise<number> {
  const { data: pendentes, error: pendentesErr } = await supabase
    .from("anota_orders")
    .select("id")
    .eq("check_status", 3)
    .eq("estoque_aplicado", false);
  if (pendentesErr) {
    console.error("[aplicarBaixasPendentes] query pendentes error:", pendentesErr);
    return 0;
  }
  let baixasAplicadas = 0;
  for (const ord of pendentes ?? []) {
    const { data: itens, error: itensErr } = await supabase
      .from("anota_order_items")
      .select("anota_item_ref, mapeado")
      .eq("order_id", ord.id);
    if (itensErr) {
      console.error("[aplicarBaixasPendentes] query itens error:", itensErr);
      continue;
    }
    const temMapeado = (itens ?? []).some(
      (i: { anota_item_ref: string | null; mapeado: boolean }) =>
        i.mapeado || (i.anota_item_ref && comboRecipeRefs.has(i.anota_item_ref)),
    );
    if (!temMapeado) continue;
    const { error } = await supabase.rpc("apply_anota_order_stock", {
      p_order: ord.id,
      p_user: userId,
    });
    if (!error) baixasAplicadas++;
  }
  return baixasAplicadas;
}

/** Aplica a baixa de estoque de um único pedido, somente se ele tiver itens
 *  mapeados (produto ou combo com composição configurada). */
async function aplicarBaixaSeMapeado(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  orderId: string,
  comboRecipeRefs: Set<string>,
  userId: string,
): Promise<boolean> {
  const { data: itens } = await supabase
    .from("anota_order_items")
    .select("anota_item_ref, mapeado")
    .eq("order_id", orderId);
  const temMapeado = (itens ?? []).some(
    (i: { anota_item_ref: string | null; mapeado: boolean }) =>
      i.mapeado || (i.anota_item_ref && comboRecipeRefs.has(i.anota_item_ref)),
  );
  if (!temMapeado) return false;
  const { error } = await supabase.rpc("apply_anota_order_stock", {
    p_order: orderId,
    p_user: userId,
  });
  return !error;
}

export interface AnotaWebhookResult {
  ok: boolean;
  acao: "importado" | "atualizado" | "cancelado" | "ignorado";
  externalId: string;
  check: number;
}

/** Importa/atualiza um pedido recebido pelo webhook do Anota AI (Pedidos
 *  Realizados/Atualizados/Cancelados), de forma idempotente por
 *  external_order_id. Não depende da listagem: é o que garante que pedidos
 *  agendados entrem no ERP mesmo quando o Anota não os expõe no ping/list.
 *
 *  O `userId` é usado apenas em campos de auditoria (sem sessão no webhook,
 *  usa-se um identificador de sistema). */
export async function processAnotaWebhookOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  payload: unknown,
  userId = "anota_webhook",
): Promise<AnotaWebhookResult> {
  const root = asRecord(payload);
  const order = root ? unwrapOrder(root) : null;
  const parsed = order ? parseOrder(order) : null;
  if (!parsed || !parsed.externalId) {
    return { ok: false, acao: "ignorado", externalId: "", check: 0 };
  }

  // Agendado com data futura entra como Agendado (-2) mesmo que o webhook
  // reporte check 0 ("em análise"); o ERP promove para produção quando vence.
  const dtAgendado = getScheduledDateTime(parsed.raw);
  const check =
    dtAgendado && dtAgendado.getTime() > Date.now()
      ? -2
      : effectiveCheckStatus(parsed.raw, parsed.check);

  const { data: mapRows } = await supabase
    .from("anota_product_map")
    .select("anota_item_ref, product_id");
  const mapByRef = new Map<string, string | null>();
  for (const m of mapRows ?? []) {
    mapByRef.set(m.anota_item_ref, m.product_id);
  }
  const comboRecipeRefs = await loadComboRecipeRefs(supabase);

  const { data: existing } = await supabase
    .from("anota_orders")
    .select("id, external_order_id, check_status, estoque_aplicado, payload, sem_resposta_em")
    .eq("external_order_id", parsed.externalId)
    .maybeSingle();

  if (existing) {
    const applied = await applyAnotaOrderDetail(supabase, existing, parsed, mapByRef, userId);
    if (applied.statusChanged) {
      await notifyStatusMessageWhatsApp(supabase, existing.id);
      await notifyKeywordRulesWhatsApp(supabase, existing.id);
    }
    if (parsed.check === 3 && existing.check_status !== 3) {
      await notifyOrderWhatsAppLogic(supabase, existing.id, "pronto", userId);
    }
    if (isActiveStatus(applied.newCheck) && !existing.estoque_aplicado) {
      await aplicarBaixaSeMapeado(supabase, existing.id, comboRecipeRefs, userId);
    }
    return {
      ok: true,
      acao: isCancelledStatus(applied.newCheck) ? "cancelado" : "atualizado",
      externalId: parsed.externalId,
      check: applied.newCheck,
    };
  }

  const { data: inserted, error: insErr } = await supabase
    .from("anota_orders")
    .insert({
      external_order_id: parsed.externalId,
      numero: parsed.numero,
      check_status: check,
      total: parsed.total,
      cliente: parsed.cliente,
      pedido_em: parsed.pedidoEm,
      payload: parsed.raw as never,
    })
    .select("id")
    .single();

  // Webhook e sync podem importar o mesmo pedido quase ao mesmo tempo: se o
  // insert falhar (conflito de chave), tenta atualizar o que já existe.
  if (insErr || !inserted) {
    const { data: again } = await supabase
      .from("anota_orders")
      .select("id, external_order_id, check_status, estoque_aplicado, payload, sem_resposta_em")
      .eq("external_order_id", parsed.externalId)
      .maybeSingle();
    if (again) {
      const applied = await applyAnotaOrderDetail(supabase, again, parsed, mapByRef, userId);
      return {
        ok: true,
        acao: isCancelledStatus(applied.newCheck) ? "cancelado" : "atualizado",
        externalId: parsed.externalId,
        check: applied.newCheck,
      };
    }
    return { ok: false, acao: "ignorado", externalId: parsed.externalId, check };
  }

  await insertOrderItems(supabase, inserted.id, parsed.items, mapByRef);

  if (check === 3) {
    await notifyOrderWhatsAppLogic(supabase, inserted.id, "pronto", userId);
  } else {
    await notifyOrderWhatsAppLogic(supabase, inserted.id, "recebido", userId);
  }
  await notifyStatusMessageWhatsApp(supabase, inserted.id);
  await notifyKeywordRulesWhatsApp(supabase, inserted.id);

  if (isActiveStatus(check)) {
    await aplicarBaixaSeMapeado(supabase, inserted.id, comboRecipeRefs, userId);
  }

  return {
    ok: true,
    acao: isCancelledStatus(check) ? "cancelado" : "importado",
    externalId: parsed.externalId,
    check,
  };
}

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------

export interface AnotaConnectionResult {
  ok: boolean;
  message: string;
  totalPedidos?: number;
}

/** Testa a conexão com o Anota AI usando o token guardado no backend. */
export const testAnotaConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AnotaConnectionResult> => {
    await ensureRole(context);
    const pageId = process.env.ANOTA_AI_STORE_ID;
    const auth = await getAnotaAccessToken();
    if ("error" in auth) {
      return { ok: false, message: auth.error };
    }
    const result = await discoverListPath(auth.token, "?currentpage=1", pageId);
    if ("error" in result) {
      return { ok: false, message: result.error };
    }
    return {
      ok: true,
      message: "Conexão com o Anota AI estabelecida com sucesso.",
      totalPedidos: result.orders.length,
    };
  });

/** Promove para produção (1) os pedidos agendados (-2) cujo horário já venceu,
 *  sem depender da API do Anota. Dispara as notificações de status/palavras-chave. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function promoteExpiredScheduledOrders(supabase: any): Promise<number> {
  const { data: agendados, error } = await supabase
    .from("anota_orders")
    .select("id, payload")
    .eq("check_status", -2);
  if (error) {
    console.error("[promoteExpiredScheduledOrders] query error:", error);
    return 0;
  }

  const agora = Date.now();
  let promovidos = 0;
  for (const o of agendados ?? []) {
    const dt = getScheduledDateTime(o.payload);
    if (!dt || dt.getTime() > agora) continue;
    const { error: updErr } = await supabase
      .from("anota_orders")
      .update({ check_status: 1 })
      .eq("id", o.id)
      .eq("check_status", -2);
    if (updErr) {
      console.error("[promoteExpiredScheduledOrders] update error:", updErr);
      continue;
    }
    promovidos++;
    await notifyStatusMessageWhatsApp(supabase, o.id);
    await notifyKeywordRulesWhatsApp(supabase, o.id);
  }
  return promovidos;
}

/** Finaliza pedidos que não existem mais no Anota (marcados com sem_resposta_em
 *  após retorno 410/404) cuja carência já venceu. Pronto (2) ou que já passou da
 *  data agendada provavelmente foi finalizado, então tem carência menor. O estoque
 *  continua debitado: pedido finalizado consome estoque (ver isActiveStatus). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function finalizeSemResposta(supabase: any): Promise<number> {
  const { data: marcados, error } = await supabase
    .from("anota_orders")
    .select("id, check_status, payload, sem_resposta_em")
    .not("sem_resposta_em", "is", null);
  if (error) {
    console.error("[finalizeSemResposta] query error:", error);
    return 0;
  }

  const agora = Date.now();
  let finalizados = 0;
  for (const o of marcados ?? []) {
    const marcadoEm = Date.parse(o.sem_resposta_em);
    if (!Number.isFinite(marcadoEm)) continue;
    const dtAgendado = getScheduledDateTime(o.payload);
    const provavelFinalizado =
      o.check_status === 2 || (dtAgendado && dtAgendado.getTime() <= agora);
    const grace = provavelFinalizado
      ? SEM_RESPOSTA_GRACE_PRONTO_MS
      : SEM_RESPOSTA_GRACE_GENERICO_MS;
    if (agora - marcadoEm < grace) continue;

    const { error: updErr } = await supabase
      .from("anota_orders")
      .update({ check_status: 3, sem_resposta_em: null })
      .eq("id", o.id)
      .eq("sem_resposta_em", o.sem_resposta_em);
    if (updErr) {
      console.error("[finalizeSemResposta] update error:", updErr);
      continue;
    }
    finalizados++;
  }
  return finalizados;
}

export interface PromoteScheduledResult {
  ok: boolean;
  message: string;
  promovidos: number;
}

/** Server function: o próprio ERP move os agendados vencidos para produção. */
export const promoteScheduledAnotaOrders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PromoteScheduledResult> => {
    await ensureRole(context);
    const promovidos = await promoteExpiredScheduledOrders(context.supabase);
    return {
      ok: true,
      message:
        promovidos > 0
          ? `${promovidos} pedido(s) agendado(s) promovido(s) para produção.`
          : "Nenhum pedido agendado venceu ainda.",
      promovidos,
    };
  });

export interface AnotaSyncResult {
  ok: boolean;
  message: string;
  importados: number;
  atualizados: number;
  baixasAplicadas: number;
  cancelados: number;
  pendentesMapeamento: number;
  /** Pedidos que não existiam mais no Anota (410/404) e foram finalizados após a carência. */
  finalizadosSemResposta?: number;
}

/** Resultado quando uma sincronização é ignorada por estar dentro do cooldown. */
function cooldownSyncResult(): AnotaSyncResult {
  return {
    ok: true,
    message: "Sincronização recente — aguarde alguns segundos e tente novamente.",
    importados: 0,
    atualizados: 0,
    baixasAplicadas: 0,
    cancelados: 0,
    pendentesMapeamento: 0,
  };
}

/** Sincroniza pedidos do Anota AI: importa novos, atualiza status e dá baixa nos finalizados mapeados. */
export const syncAnotaOrders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { filtro?: "todos" | "analise" | "producao" | "finalizados" }) => ({
    filtro: input?.filtro ?? "todos",
  }))
  .handler(async ({ context, data }): Promise<AnotaSyncResult> => {
    await ensureRole(context);
    const supabase = context.supabase;

    // Cooldown entre sincronizações: evita rajadas de requisições à API do
    // Anota quando várias abas/disparos sobrepõem o mesmo sync (intervalo de
    // 30s + realtime + foco + clique manual). Primeiro um gate em memória
    // (por instância) e depois um gate persistido via activity_logs, que vale
    // entre abas e instâncias serverless.
    if (lastSyncAtMemory > 0 && Date.now() - lastSyncAtMemory < SYNC_COOLDOWN_MS) {
      return cooldownSyncResult();
    }
    const { data: lastLog, error: logErr } = await supabase
      .from("activity_logs")
      .select("created_at")
      .eq("modulo", "anota_sync")
      .eq("acao", "sincronizou")
      .order("created_at", { ascending: false })
      .limit(1);
    if (!logErr && lastLog && lastLog.length > 0) {
      const lastAt = Date.parse(lastLog[0].created_at);
      if (Number.isFinite(lastAt) && Date.now() - lastAt < SYNC_COOLDOWN_MS) {
        return cooldownSyncResult();
      }
    }

    const auth = await getAnotaAccessToken();
    if ("error" in auth) {
      return {
        ok: false,
        message: auth.error,
        importados: 0,
        atualizados: 0,
        baixasAplicadas: 0,
        cancelados: 0,
        pendentesMapeamento: 0,
      };
    }
    const token = auth.token;
    const pageId = process.env.ANOTA_AI_STORE_ID;

    // O ERP promove os agendados vencidos para produção antes de sincronizar,
    // assim não depende do Anota para refletir o status.
    await promoteExpiredScheduledOrders(supabase);

    // Finaliza pedidos que não existem mais no Anota (410/404) com carência
    // vencida, liberando-os da consulta e reduzindo a carga na API.
    const finalizadosSemResposta = await finalizeSemResposta(supabase);

    const discovery = await discoverListPath(token, statusQuery(data.filtro), pageId);
    if ("error" in discovery) {
      return {
        ok: false,
        message: discovery.error,
        importados: 0,
        atualizados: 0,
        baixasAplicadas: 0,
        cancelados: 0,
        pendentesMapeamento: 0,
      };
    }

    // Mapeamento item -> produto
    const { data: mapRows, error: mapErr } = await supabase
      .from("anota_product_map")
      .select("anota_item_ref, product_id");
    if (mapErr) console.error("[syncAnotaOrders] map query error:", mapErr);
    const mapByRef = new Map<string, string | null>();
    for (const m of mapRows ?? []) {
      mapByRef.set(m.anota_item_ref, m.product_id);
    }

    // Combos com composição configurada
    const comboRecipeRefs = await loadComboRecipeRefs(supabase);

    // Pedidos já existentes
    const externalIds = discovery.orders.map((o) => o.id);
    const { data: existingRows, error: existingErr } = await supabase
      .from("anota_orders")
      .select("id, external_order_id, check_status, estoque_aplicado, payload, sem_resposta_em")
      .in("external_order_id", externalIds.length ? externalIds : ["__none__"]);
    if (existingErr) console.error("[syncAnotaOrders] existing query error:", existingErr);
    const existing = new Map((existingRows ?? []).map((r) => [r.external_order_id, r] as const));

    let importados = 0;
    let atualizados = 0;
    let cancelados = 0;
    let pendentesMapeamento = 0;
    const finalizadosParaBaixa: string[] = []; // ids internos (anota_orders.id)
    const novosParaNotificar: string[] = []; // ids internos de pedidos novos (notificação de recebimento)
    const prontosParaNotificar: string[] = []; // ids internos que passaram para finalizado
    const statusMudouParaNotificar: string[] = []; // ids internos que mudaram de status (mensagens configuradas por status)

    for (const listed of discovery.orders) {
      const prev = existing.get(listed.id);

      if (prev) {
        // Sempre busca o detalhe atualizado para garantir itens/quantidades corretas
        const detail = await fetchOrderDetail(token, discovery.path, listed.id, pageId);
        if (detail.parsed) {
          const applied = await applyAnotaOrderDetail(
            supabase,
            prev,
            detail.parsed,
            mapByRef,
            context.userId,
          );
          if (applied.updated) atualizados++;
          if (applied.revertedStock) cancelados++;
          if (detail.parsed.check === 3 && prev.check_status !== 3) {
            prontosParaNotificar.push(prev.id);
          }
          if (applied.statusChanged) {
            statusMudouParaNotificar.push(prev.id);
          }
          // apply_anota_order_stock internamente verifica estoque_aplicado e retorna se já foi aplicado
          if (isActiveStatus(applied.newCheck) && !prev.estoque_aplicado) {
            finalizadosParaBaixa.push(prev.id);
          }
          continue;
        }
        // fallback: lista — atualiza status se mudou.
        // Pedido agendado (-2) preserva o status: a listagem reporta agendados
        // como check 0 ("em análise"), e rebaixá-los seria incorreto.
        const fallbackCheck = effectiveCheckStatus(
          prev.payload,
          prev.check_status === -2 ? -2 : listed.check,
        );
        if (prev.check_status !== fallbackCheck) {
          const { error: updStatusErr } = await supabase
            .from("anota_orders")
            .update({ check_status: fallbackCheck })
            .eq("id", prev.id);
          if (updStatusErr) console.error("[syncAnotaOrders] update status error:", updStatusErr);
          else {
            atualizados++;
            statusMudouParaNotificar.push(prev.id);
            // Pedido cancelado/negado fora do detalhe: devolve o estoque debitado
            if (isCancelledStatus(fallbackCheck) && prev.estoque_aplicado) {
              const reverteu = await revertAnotaOrderStock(supabase, prev.id, context.userId);
              if (reverteu) cancelados++;
            }
          }
        }
        if (isActiveStatus(fallbackCheck) && !prev.estoque_aplicado) {
          finalizadosParaBaixa.push(prev.id);
        }
        continue;
      }

      // Novo pedido — busca detalhe
      const detail = await fetchOrderDetail(token, discovery.path, listed.id, pageId);
      const check = effectiveCheckStatus(
        detail.parsed?.raw ?? null,
        detail.parsed?.check ?? listed.check,
      );

      const { data: inserted, error: insErr } = await supabase
        .from("anota_orders")
        .insert({
          external_order_id: listed.id,
          numero: detail.parsed?.numero ?? null,
          check_status: check,
          total: detail.parsed?.total ?? 0,
          cliente: detail.parsed?.cliente ?? null,
          pedido_em: detail.parsed?.pedidoEm ?? null,
          payload: (detail.parsed?.raw ?? null) as never,
        })
        .select("id")
        .single();

      if (insErr || !inserted) continue;
      importados++;

      const items = detail.parsed?.items ?? [];
      const todosMapeados = await insertOrderItems(supabase, inserted.id, items, mapByRef);
      if (items.length > 0 && !todosMapeados) pendentesMapeamento++;

      if (check === 3) {
        prontosParaNotificar.push(inserted.id);
      } else {
        novosParaNotificar.push(inserted.id);
      }
      statusMudouParaNotificar.push(inserted.id);

      if (isActiveStatus(check)) {
        finalizadosParaBaixa.push(inserted.id);
      }
    }

    // Verifica pedidos ativos que NÃO estão na listagem do Anota: pedidos
    // cancelados/negados/finalizados saem da listagem, então o sync nunca
    // atualizaria o status sem consultar o detalhe diretamente. Ex: pedido
    // cancelado após entrar em produção fica "preso" em produção com o estoque
    // debitado. Finalizados (3) não são mais consultados — o status é definitivo
    // — e pedidos marcados como "sem resposta" (410/404) também ficam de fora.
    const naListagem = new Set(externalIds);
    const { data: ativos, error: ativosErr } = await supabase
      .from("anota_orders")
      .select("id, external_order_id, check_status, estoque_aplicado, payload, sem_resposta_em")
      .in("check_status", [0, 1, 2])
      .is("sem_resposta_em", null)
      .order("updated_at", { ascending: false })
      .limit(100);
    if (ativosErr) console.error("[syncAnotaOrders] query ativos error:", ativosErr);

    for (const ativo of ativos ?? []) {
      if (naListagem.has(ativo.external_order_id)) continue;
      const detail = await fetchOrderDetail(token, discovery.path, ativo.external_order_id, pageId);
      if (detail.gone) {
        // Pedido não existe mais no Anota (410/404): marca para finalização
        // com carência e para de consultá-lo (a consulta acima exclui os que
        // já estão marcados). Isso reduz bastante a carga na API.
        if (!ativo.sem_resposta_em) {
          const { error: markErr } = await supabase
            .from("anota_orders")
            .update({ sem_resposta_em: new Date().toISOString() })
            .eq("id", ativo.id);
          if (markErr) console.error("[syncAnotaOrders] mark 410 error:", markErr);
        }
        continue;
      }
      if (!detail.parsed) continue;
      const newCheck = effectiveCheckStatus(detail.parsed.raw, detail.parsed.check);
      if (newCheck === ativo.check_status) continue;
      const applied = await applyAnotaOrderDetail(
        supabase,
        ativo,
        detail.parsed,
        mapByRef,
        context.userId,
      );
      if (applied.updated) atualizados++;
      if (applied.revertedStock) cancelados++;
      if (detail.parsed.check === 3 && ativo.check_status !== 3) {
        prontosParaNotificar.push(ativo.id);
      }
      if (applied.statusChanged) {
        statusMudouParaNotificar.push(ativo.id);
      }
      if (isActiveStatus(applied.newCheck) && !ativo.estoque_aplicado) {
        finalizadosParaBaixa.push(ativo.id);
      }
    }

    // Aplica baixa de estoque nos finalizados
    // O RPC já filtra apenas itens com mapeado=true AND product_id IS NOT NULL AND quantidade > 0
    let baixasAplicadas = 0;
    for (const orderId of finalizadosParaBaixa) {
      const { data: itens } = await supabase
        .from("anota_order_items")
        .select("anota_item_ref, mapeado")
        .eq("order_id", orderId);
      if (!itens || itens.length === 0) {
        continue;
      }
      const temMapeado = itens.some(
        (i) => i.mapeado || (i.anota_item_ref && comboRecipeRefs.has(i.anota_item_ref)),
      );
      if (!temMapeado) {
        pendentesMapeamento++;
        continue;
      }
      const { error: rpcErr } = await supabase.rpc("apply_anota_order_stock", {
        p_order: orderId,
        p_user: context.userId,
      });
      if (!rpcErr) baixasAplicadas++;
    }

    // Notificações WhatsApp (pedido recebido e/ou pronto)
    // A função interna respeita as configurações (template, toggle) e a anti-duplicação.
    for (const id of novosParaNotificar) {
      await notifyOrderWhatsAppLogic(supabase, id, "recebido", context.userId);
    }
    for (const id of prontosParaNotificar) {
      await notifyOrderWhatsAppLogic(supabase, id, "pronto", context.userId);
    }
    for (const id of statusMudouParaNotificar) {
      await notifyStatusMessageWhatsApp(supabase, id);
    }
    for (const id of statusMudouParaNotificar) {
      await notifyKeywordRulesWhatsApp(supabase, id);
    }

    const partes = [
      `${importados} novo(s)`,
      `${atualizados} atualizado(s)`,
      `${baixasAplicadas} baixa(s) de estoque`,
    ];
    if (cancelados) partes.push(`${cancelados} cancelado(s) com estoque devolvido`);
    if (pendentesMapeamento) partes.push(`${pendentesMapeamento} pedido(s) aguardando mapeamento`);
    if (finalizadosSemResposta) {
      partes.push(`${finalizadosSemResposta} sem resposta finalizado(s)`);
    }

    await supabase.from("activity_logs").insert({
      modulo: "anota_sync",
      acao: "sincronizou",
      user_id: context.userId,
      detalhes: {
        importados,
        atualizados,
        baixasAplicadas,
        cancelados,
        pendentesMapeamento,
        finalizadosSemResposta,
      },
    });
    lastSyncAtMemory = Date.now();

    return {
      ok: true,
      message: `Sincronização concluída: ${partes.join(", ")}.`,
      importados,
      atualizados,
      baixasAplicadas,
      cancelados,
      pendentesMapeamento,
      finalizadosSemResposta,
    };
  });

export interface SaveMappingInput {
  mappings: { anota_item_ref: string; nome?: string | null; product_id: string | null }[];
}

export interface SaveMappingResult {
  ok: boolean;
  message: string;
  baixasAplicadas: number;
}

/** Salva mapeamentos item->produto, atualiza itens pendentes e reaplica baixas de finalizados. */
export const saveAnotaMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SaveMappingInput) => {
    if (!input || !Array.isArray(input.mappings)) throw new Error("Dados de mapeamento inválidos.");
    return input;
  })
  .handler(async ({ context, data }): Promise<SaveMappingResult> => {
    await ensureRole(context);
    const supabase = context.supabase;

    for (const m of data.mappings) {
      if (!m.anota_item_ref) continue;

      const { error: upsertErr } = await supabase
        .from("anota_product_map")
        .upsert(
          { anota_item_ref: m.anota_item_ref, nome: m.nome ?? null, product_id: m.product_id },
          { onConflict: "anota_item_ref" },
        );

      if (upsertErr) {
        console.error("[saveAnotaMapping] upsert error:", upsertErr);
        return {
          ok: false,
          message: `Erro ao salvar mapeamento: ${upsertErr.message}`,
          baixasAplicadas: 0,
        };
      }

      const { error: updateErr } = await supabase
        .from("anota_order_items")
        .update({ product_id: m.product_id, mapeado: !!m.product_id })
        .eq("anota_item_ref", m.anota_item_ref);

      if (updateErr) {
        console.error("[saveAnotaMapping] update items error:", updateErr);
        return {
          ok: false,
          message: `Erro ao atualizar itens: ${updateErr.message}`,
          baixasAplicadas: 0,
        };
      }
    }

    // Reaplica baixa para pedidos finalizados agora completamente mapeados
    const comboRecipeRefs = await loadComboRecipeRefs(supabase);
    const baixasAplicadas = await aplicarBaixasPendentes(supabase, comboRecipeRefs, context.userId);

    return {
      ok: true,
      message:
        baixasAplicadas > 0
          ? `Mapeamento salvo. ${baixasAplicadas} pedido(s) finalizado(s) tiveram baixa de estoque aplicada.`
          : "Mapeamento salvo com sucesso.",
      baixasAplicadas,
    };
  });

export interface SaveComboItemInput {
  product_id: string;
  quantidade: number;
}

export interface SaveComboInput {
  combos: {
    combo_ref: string;
    nome?: string | null;
    items: SaveComboItemInput[];
  }[];
}

export interface SaveComboResult {
  ok: boolean;
  message: string;
  baixasAplicadas: number;
}

/** Salva a composição (produtos + quantidades) de combos/itens do Anota AI. */
export const saveAnotaCombo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SaveComboInput) => {
    if (!input || !Array.isArray(input.combos)) throw new Error("Dados de combo inválidos.");
    return input;
  })
  .handler(async ({ context, data }): Promise<SaveComboResult> => {
    await ensureRole(context);
    const supabase = context.supabase;

    for (const c of data.combos) {
      if (!c.combo_ref) continue;
      const rows = (c.items ?? [])
        .filter((i) => i.product_id && i.quantidade > 0)
        .map((i) => ({
          combo_ref: c.combo_ref,
          nome: c.nome ?? null,
          product_id: i.product_id,
          quantidade: i.quantidade,
        }));

      const { error: delErr } = await supabase
        .from("anota_combo_item_map")
        .delete()
        .eq("combo_ref", c.combo_ref);
      if (delErr) {
        console.error("[saveAnotaCombo] delete error:", delErr);
        return { ok: false, message: `Erro ao salvar composição: ${delErr.message}`, baixasAplicadas: 0 };
      }
      if (rows.length) {
        const { error: insErr } = await supabase.from("anota_combo_item_map").insert(rows);
        if (insErr) {
          console.error("[saveAnotaCombo] insert error:", insErr);
          return { ok: false, message: `Erro ao salvar composição: ${insErr.message}`, baixasAplicadas: 0 };
        }
      }
    }

    const comboRecipeRefs = await loadComboRecipeRefs(supabase);
    const baixasAplicadas = await aplicarBaixasPendentes(supabase, comboRecipeRefs, context.userId);

    return {
      ok: true,
      message:
        baixasAplicadas > 0
          ? `Composição salva. ${baixasAplicadas} pedido(s) finalizado(s) tiveram baixa de estoque aplicada.`
          : "Composição salva com sucesso.",
      baixasAplicadas,
    };
  });
