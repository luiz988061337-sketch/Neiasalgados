import { useMemo, useState, useEffect, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ShoppingBag,
  RefreshCw,
  Plug,
  Loader2,
  Link2,
  AlertTriangle,
  CheckCircle2,
  Eye,
  CalendarDays,
  Search,
  Filter,
  Clock,
  Send,
  Save,
  QrCode,
  Plus,
  Trash2,
  ImagePlus,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import {
  testAnotaConnection,
  syncAnotaOrders,
  saveAnotaMapping,
  saveAnotaCombo,
  ANOTA_CHECK_LABELS,
} from "@/lib/anota.functions";
import {
  testWhatsAppConnection,
  getWhatsAppSettings,
  saveWhatsAppSettings,
  getWhatsAppNotifications,
  saveWhatsAppNotifications,
  getWhatsAppKeywordRules,
  saveWhatsAppKeywordRules,
  setOrderMotoboy,
  sendOrderMessage,
  getWhatsAppStatus,
  getWhatsAppQrCode,
  createWhatsAppSession,
  FIXED_NOTIFICATION_REGRAS,
  type NotifyType,
  type WhatsAppNotification,
  type WhatsAppKeywordRule,
} from "@/lib/whatsapp.functions";
import { fmtMoney, fmtDateTime } from "@/lib/format";
import { PageHeader, KpiCard, EmptyState } from "@/components/erp/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isSyncEnabled, setSyncEnabled, onSyncToggle } from "@/lib/sync-toggle";
import { useRealtime } from "@/hooks/useRealtime";

export const Route = createFileRoute("/_authenticated/anota")({
  component: AnotaPage,
});

type Filtro = "todos" | "analise" | "producao" | "finalizados";

function diasAte(dataStr: string): string {
  const data = new Date(dataStr);
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  data.setHours(0, 0, 0, 0);
  const diff = Math.round((data.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "D+0";
  if (diff > 0) return `D+${diff}`;
  return `D${diff}`;
}

function getScheduledDate(payload: any): string | null {
  if (!payload) return null;
  return payload.preparationStartDateTime || payload.schedule_order?.date || null;
}

const CHECK_TONE: Record<number, "default" | "secondary" | "destructive" | "outline"> = {
  [-2]: "outline",
  0: "outline",
  1: "secondary",
  2: "secondary",
  3: "default",
  4: "destructive",
  5: "destructive",
  6: "destructive",
};

function checkBadge(check: number, scheduledDate?: string | null, semResposta?: boolean) {
  if (check === -2) {
    const label = scheduledDate ? `Agendamento ${diasAte(scheduledDate)}` : "Agendamento";
    return (
      <Badge variant="outline" className="text-info border-info/30 bg-info/15">
        {label}
      </Badge>
    );
  }
  if (semResposta) {
    return (
      <Badge variant="outline" className="text-warning border-warning/30 bg-warning/15">
        Esperando atualização
      </Badge>
    );
  }
  return (
    <Badge variant={CHECK_TONE[check] ?? "outline"}>
      {ANOTA_CHECK_LABELS[check] ?? `Status ${check}`}
    </Badge>
  );
}

const STATUS_MESSAGE_OPTIONS = [
  { value: -2, label: "Agendado" },
  ...Object.entries(ANOTA_CHECK_LABELS).map(([k, v]) => ({ value: Number(k), label: v })),
];

const DEFAULT_NOTIF_TITLES: Record<string, string> = {
  pedido_recebido: "Pedido recebido",
  pedido_pronto: "Pedido pronto",
  motoboy: "Pedido pronto (motoboy)",
  "status_-2": "Agendamento",
};

const TEMPLATE_VARIABLES = [
  "{{numero}}",
  "{{total}}",
  "{{total_com_taxa}}",
  "{{sub_total}}",
  "{{cliente}}",
  "{{pagamento}}",
  "{{agendamento}}",
  "{{taxa_entrega}}",
  "{{taxa_motoboy}}",
  "{{endereco}}",
  "{{endereço}}",
  "{{entrega}}",
  "{{pedido}}",
];

function AnotaPage() {
  const qc = useQueryClient();
  const [syncEnabled, setSyncEnabledState] = useState(() => isSyncEnabled());
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [buscaData, setBuscaData] = useState(new Date().toISOString().split("T")[0]);
  const [buscaStatus, setBuscaStatus] = useState<"todos" | "producao" | "finalizados">("todos");
  const [buscaTexto, setBuscaTexto] = useState("");

  useEffect(() => {
    const unsub = onSyncToggle((enabled) => setSyncEnabledState(enabled));
    return unsub;
  }, []);

  // Atualiza a tela em tempo real quando qualquer cliente (ou o sync)
  // altera os dados de pedidos/mapeamento do Anota.
  useRealtime(
    ["anota_orders", "anota_order_items", "anota_product_map", "anota_combo_item_map"],
    ["anota-orders", "anota-items", "anota-combo-map", "anota-scheduled", "anota-busca", "dashboard"],
  );

  const testFn = useServerFn(testAnotaConnection);
  const syncFn = useServerFn(syncAnotaOrders);
  const saveMapFn = useServerFn(saveAnotaMapping);
  const saveComboFn = useServerFn(saveAnotaCombo);
  const whatsSettingsFn = useServerFn(getWhatsAppSettings);
  const saveWhatsSettingsFn = useServerFn(saveWhatsAppSettings);
  const getNotifsFn = useServerFn(getWhatsAppNotifications);
  const saveNotifsFn = useServerFn(saveWhatsAppNotifications);
  const testWhatsFn = useServerFn(testWhatsAppConnection);
  const setMotoboyFn = useServerFn(setOrderMotoboy);
  const sendMsgFn = useServerFn(sendOrderMessage);
  const whatsStatusFn = useServerFn(getWhatsAppStatus);
  const whatsQrFn = useServerFn(getWhatsAppQrCode);
  const createSessionFn = useServerFn(createWhatsAppSession);
  const getKeywordRulesFn = useServerFn(getWhatsAppKeywordRules);
  const saveKeywordRulesFn = useServerFn(saveWhatsAppKeywordRules);

  const { data: orders = [], refetch: refetchOrders } = useQuery({
    queryKey: ["anota-orders"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("anota_orders")
        .select(
          "id, external_order_id, numero, check_status, total, cliente, pedido_em, estoque_aplicado, imported_at, sem_resposta_em",
        )
        .order("imported_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return data;
    },
    refetchInterval: 30000,
  });

  const { data: items = [] } = useQuery({
    queryKey: ["anota-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("anota_order_items")
        .select("anota_item_ref, nome, product_id, mapeado, is_combo, combo_ref");
      if (error) throw error;
      return data;
    },
  });

  const { data: comboMap = [] } = useQuery({
    queryKey: ["anota-combo-map"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("anota_combo_item_map")
        .select("combo_ref, nome, product_id, quantidade");
      if (error) throw error;
      return data;
    },
  });

  const { data: scheduledWithPayload = [] } = useQuery({
    queryKey: ["anota-scheduled"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("anota_orders")
        .select(
          "id, external_order_id, numero, check_status, total, cliente, pedido_em, estoque_aplicado, imported_at, payload",
        )
        .eq("check_status", -2)
        .order("imported_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: buscaResults = [] } = useQuery({
    queryKey: ["anota-busca", buscaData, buscaStatus, buscaTexto],
    queryFn: async () => {
      const termo = buscaTexto.trim();
      let query = supabase
        .from("anota_orders")
        .select(
          "id, external_order_id, numero, check_status, total, cliente, pedido_em, estoque_aplicado, imported_at, sem_resposta_em",
        );
      if (termo) {
        query = query.or(
          `cliente.ilike.%${termo}%,numero.ilike.%${termo}%,external_order_id.ilike.%${termo}%`,
        );
      } else {
        const from = new Date(buscaData);
        from.setHours(0, 0, 0, 0);
        const to = new Date(from);
        to.setDate(to.getDate() + 1);
        query = query
          .gte("imported_at", from.toISOString())
          .lt("imported_at", to.toISOString());
      }
      query = query.order("imported_at", { ascending: false });
      if (buscaStatus === "producao") query = query.eq("check_status", 1);
      else if (buscaStatus === "finalizados") query = query.eq("check_status", 3);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  const { data: products = [] } = useQuery({
    queryKey: ["products-lite"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id, nome")
        .is("deleted_at", null)
        .order("nome");
      if (error) throw error;
      return data;
    },
  });

  const { data: collaborators = [] } = useQuery({
    queryKey: ["collaborators-lite"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("collaborators")
        .select("id, nome, cargo, celular")
        .is("deleted_at", null)
        .order("nome");
      if (error) throw error;
      return data;
    },
  });

  const { data: whatsSettings = {}, refetch: refetchWhatsSettings } = useQuery({
    queryKey: ["whatsapp-settings"],
    queryFn: async () => {
      const r = await whatsSettingsFn();
      return r.ok ? r.settings : {};
    },
  });

  const { data: whatsNotifs = [], isFetched: notifsFetched, refetch: refetchWhatsNotifs } = useQuery({
    queryKey: ["whatsapp-notifications"],
    queryFn: async () => {
      const r = await getNotifsFn();
      return r.ok ? r.notifications : [];
    },
  });

  const [whatsDraft, setWhatsDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setWhatsDraft((s) => {
      const merged: Record<string, string> = {};
      for (const k of Object.keys(whatsSettings)) merged[k] = s[k] ?? whatsSettings[k];
      return merged;
    });
  }, [whatsSettings]);

  const [notifDraft, setNotifDraft] = useState<WhatsAppNotification[]>([]);
  // Regras editadas localmente pelo usuário (para não sobrescrever edições
  // pendentes quando o servidor refaz o fetch).
  const dirtyRegrasRef = useRef<Set<string>>(new Set());

  const markDirty = (regra: string) => {
    dirtyRegrasRef.current.add(regra);
  };

  const clearDirty = () => {
    dirtyRegrasRef.current.clear();
  };

  useEffect(() => {
    setNotifDraft((prev) => {
      if (!notifsFetched) return prev;
      if (whatsNotifs.length) {
        const serverRegras = new Set(whatsNotifs.map((n) => n.regra));
        const merged = whatsNotifs.map((n) => {
          const local = prev.find((p) => p.regra === n.regra);
          if (local && dirtyRegrasRef.current.has(n.regra)) return local;
          return { ...n };
        });
        // Mantém itens locais que ainda não existem no servidor (regras novas)
        for (const p of prev) {
          if (!serverRegras.has(p.regra)) merged.push(p);
        }
        return merged;
      }
      if (prev.length) return prev;
      return FIXED_NOTIFICATION_REGRAS.map((regra) => ({
        id: "",
        regra,
        titulo: DEFAULT_NOTIF_TITLES[regra] ?? regra,
        mensagem: "",
        status: null,
        imagem_url: null,
        ativo: true,
      }));
    });
  }, [whatsNotifs, notifsFetched]);

  const upsertNotifDraft = (next: WhatsAppNotification) => {
    markDirty(next.regra);
    setNotifDraft((prev) => {
      const i = prev.findIndex((n) => n.regra === next.regra);
      if (i >= 0) {
        const copy = [...prev];
        copy[i] = next;
        return copy;
      }
      return [...prev, next];
    });
  };

  const removeNotifDraft = (regra: string) => {
    markDirty(regra);
    setNotifDraft((prev) => prev.filter((n) => n.regra !== regra));
  };

  const { data: keywordRules = [], refetch: refetchKeywordRules } = useQuery({
    queryKey: ["whatsapp-keyword-rules"],
    queryFn: async () => {
      const r = await getKeywordRulesFn();
      return r.ok ? r.rules : [];
    },
  });

  const [keywordDraft, setKeywordDraft] = useState<WhatsAppKeywordRule[]>([]);
  const [showRulesHelp, setShowRulesHelp] = useState(false);
  useEffect(() => {
    setKeywordDraft(keywordRules);
  }, [keywordRules]);

  const upsertKeywordRule = (next: WhatsAppKeywordRule) => {
    setKeywordDraft((prev) => {
      const i = prev.findIndex((r) => r.regra === next.regra);
      if (i >= 0) {
        const copy = [...prev];
        copy[i] = next;
        return copy;
      }
      return [...prev, next];
    });
  };

  const removeKeywordRule = (regra: string) => {
    setKeywordDraft((prev) => prev.filter((r) => r.regra !== regra));
  };

  const saveKeywordRules = useMutation({
    mutationFn: async () =>
      saveKeywordRulesFn({
        data: { rules: keywordDraft },
      }),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      qc.invalidateQueries({ queryKey: ["whatsapp-keyword-rules"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const uploadKeywordImage = async (regra: string, file: File) => {
    const ext = file.name.split(".").pop() ?? "jpg";
    const path = `regras-keywords/${regra}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from("whatsapp-notifications")
      .upload(path, file, { contentType: file.type, upsert: true });
    if (error) {
      toast.error(`Falha no upload: ${error.message}`);
      return;
    }
    const { data } = supabase.storage.from("whatsapp-notifications").getPublicUrl(path);
    const cur = keywordDraft.find((r) => r.regra === regra);
    if (cur) upsertKeywordRule({ ...cur, imagem_url: data.publicUrl });
    toast.success("Imagem enviada com sucesso.");
  };

  const removeKeywordImage = (regra: string) => {
    const cur = keywordDraft.find((r) => r.regra === regra);
    if (cur) upsertKeywordRule({ ...cur, imagem_url: null });
  };

  const slugify = (v: string) =>
    v
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  // Itens distintos por referência (para a tela de mapeamento)
  const distinctItems = useMemo(() => {
    const map = new Map<
      string,
      {
        ref: string;
        nome: string | null;
        product_id: string | null;
        count: number;
        is_combo: boolean;
      }
    >();
    for (const it of items) {
      const ref = it.anota_item_ref;
      if (!ref) continue;
      const isCombo = !!it.is_combo || /^combo\s/i.test(it.nome ?? "");
      const cur = map.get(ref);
      if (cur) {
        cur.count++;
        if (!cur.product_id && it.product_id) cur.product_id = it.product_id;
        cur.is_combo = cur.is_combo || isCombo;
      } else {
        map.set(ref, {
          ref,
          nome: it.nome,
          product_id: it.product_id,
          count: 1,
          is_combo: isCombo,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      (a.nome ?? a.ref).localeCompare(b.nome ?? b.ref),
    );
  }, [items]);

  // Composição configurada por combo: ref -> produtos com quantidade
  const comboByRef = useMemo(() => {
    const map = new Map<string, { product_id: string; quantidade: number }[]>();
    for (const c of comboMap) {
      if (!map.has(c.combo_ref)) map.set(c.combo_ref, []);
      map.get(c.combo_ref)!.push({ product_id: c.product_id, quantidade: c.quantidade });
    }
    return map;
  }, [comboMap]);

  const pendentesItems = useMemo(
    () => distinctItems.filter((d) => !d.product_id && !comboByRef.has(d.ref)),
    [distinctItems, comboByRef],
  );
  const pendentes = pendentesItems.length;

  const finalizadosSemBaixaItems = useMemo(
    () => orders.filter((o) => o.check_status === 3 && !o.estoque_aplicado),
    [orders],
  );
  const finalizadosSemBaixa = finalizadosSemBaixaItems.length;

  const [tabValue, setTabValue] = useState("pedidos");
  const [kpiDialog, setKpiDialog] = useState<null | "pendentes" | "semBaixa">(null);

  // Estado local dos selects de mapeamento
  const [mapDraft, setMapDraft] = useState<Record<string, string>>({});
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  // Editor de composição de combo
  const [comboEditingRef, setComboEditingRef] = useState<string | null>(null);
  const [comboDraft, setComboDraft] = useState<{ product_id: string; quantidade: string }[]>([]);

  function openComboEditor(ref: string) {
    const existing = comboByRef.get(ref) ?? [];
    setComboDraft(
      existing.length
        ? existing.map((e) => ({ product_id: e.product_id, quantidade: String(e.quantidade) }))
        : [{ product_id: "", quantidade: "" }],
    );
    setComboEditingRef(ref);
  }

  const comboEditingNome =
    comboEditingRef != null
      ? (distinctItems.find((x) => x.ref === comboEditingRef)?.nome ?? comboEditingRef)
      : "";

  const { data: orderItems = [] } = useQuery({
    queryKey: ["anota-order-items", selectedOrderId],
    queryFn: async () => {
      if (!selectedOrderId) return [];
      const { data, error } = await supabase
        .from("anota_order_items")
        .select("id, anota_item_ref, nome, quantidade, mapeado, product_id, is_combo, combo_ref")
        .eq("order_id", selectedOrderId)
        .order("nome");
      if (error) throw error;
      return data;
    },
    enabled: !!selectedOrderId,
  });

  const [orderDraft, setOrderDraft] = useState<any[]>([]);
  useEffect(() => {
    setOrderDraft(orderItems.map((item: any) => ({ ...item })));
  }, [orderItems]);

  const saveOrderItems = useMutation({
    mutationFn: async () => {
      if (!selectedOrderId) throw new Error("Nenhum pedido selecionado.");
      const validItems = orderDraft.filter((item) => item.nome?.trim() && Number(item.quantidade) > 0);
      const { error: deleteError } = await supabase.from("anota_order_items").delete().eq("order_id", selectedOrderId);
      if (deleteError) throw deleteError;
      if (validItems.length) {
        const { error } = await supabase.from("anota_order_items").insert(validItems.map((item) => ({
          order_id: selectedOrderId,
          anota_item_ref: item.anota_item_ref || item.nome.trim().toLowerCase().replace(/\\s+/g, "-"),
          nome: item.nome.trim(),
          quantidade: Number(item.quantidade),
          product_id: item.is_combo ? null : item.product_id || null,
          mapeado: item.is_combo ? false : !!item.product_id,
          is_combo: !!item.is_combo,
          combo_ref: item.combo_ref || null,
        })));
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Itens do pedido atualizados.");
      qc.invalidateQueries({ queryKey: ["anota-order-items", selectedOrderId] });
      qc.invalidateQueries({ queryKey: ["anota-items"] });
      qc.invalidateQueries({ queryKey: ["anota-orders"] });
    },
    onError: (error: Error) => toast.error(`Não foi possível salvar os itens: ${error.message}`),
  });

  const selectedOrder = orders.find((o) => o.id === selectedOrderId);

  const { data: selectedDetail } = useQuery({
    queryKey: ["anota-order-detail", selectedOrderId],
    queryFn: async () => {
      if (!selectedOrderId) return null;
      const { data, error } = await supabase
        .from("anota_orders")
        .select("id, numero, external_order_id, cliente, total, check_status")
        .eq("id", selectedOrderId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      let extra = {
        motoboy_id: null as string | null,
        whatsapp_notified_at: null as string | null,
        whatsapp_ready_notified_at: null as string | null,
      };
      try {
        const { data: extraData } = await supabase
          .from("anota_orders")
          .select("motoboy_id, whatsapp_notified_at, whatsapp_ready_notified_at")
          .eq("id", selectedOrderId)
          .maybeSingle();
        if (extraData) extra = extraData;
      } catch {
        // Colunas ainda não existem (migration pendente) — segue com valores vazios
      }
      return { ...data, ...extra };
    },
    enabled: !!selectedOrderId,
  });

  const test = useMutation({
    mutationFn: () => testFn(),
    onSuccess: (r) => (r.ok ? toast.success(r.message) : toast.error(r.message)),
    onError: (e: Error) => toast.error(e.message),
  });

  const sync = useMutation({
    mutationFn: () => syncFn({ data: { filtro } }),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      qc.invalidateQueries({ queryKey: ["anota-orders"] });
      qc.invalidateQueries({ queryKey: ["anota-items"] });
      qc.invalidateQueries({ queryKey: ["anota-scheduled"] });
      qc.invalidateQueries({ queryKey: ["anota-busca"] });
      qc.invalidateQueries({ queryKey: ["stock"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      refetchOrders();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveMap = useMutation({
    mutationFn: () => {
      const mappings = Object.entries(mapDraft)
        .filter(([, v]) => v)
        .map(([ref, product_id]) => {
          const d = distinctItems.find((x) => x.ref === ref);
          return {
            anota_item_ref: ref,
            nome: d?.nome ?? null,
            product_id: product_id === "none" ? null : product_id,
          };
        });
      if (!mappings.length) throw new Error("Nenhuma alteração de mapeamento para salvar.");
      return saveMapFn({ data: { mappings } });
    },
    onSuccess: (r) => {
      toast.success(r.message);
      setMapDraft({});
      qc.invalidateQueries({ queryKey: ["anota-orders"] });
      qc.invalidateQueries({ queryKey: ["anota-items"] });
      qc.invalidateQueries({ queryKey: ["anota-scheduled"] });
      qc.invalidateQueries({ queryKey: ["stock"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveCombo = useMutation({
    mutationFn: () => {
      if (!comboEditingRef) throw new Error("Nenhum combo selecionado.");
      const items = comboDraft
        .filter((i) => i.product_id && Number(i.quantidade) > 0)
        .map((i) => ({ product_id: i.product_id, quantidade: Number(i.quantidade) }));
      const d = distinctItems.find((x) => x.ref === comboEditingRef);
      return saveComboFn({
        data: { combos: [{ combo_ref: comboEditingRef, nome: d?.nome ?? null, items }] },
      });
    },
    onSuccess: (r) => {
      toast.success(r.message);
      setComboEditingRef(null);
      qc.invalidateQueries({ queryKey: ["anota-combo-map"] });
      qc.invalidateQueries({ queryKey: ["anota-items"] });
      qc.invalidateQueries({ queryKey: ["anota-orders"] });
      qc.invalidateQueries({ queryKey: ["stock"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const testWhats = useMutation({
    mutationFn: () => testWhatsFn(),
    onSuccess: (r) => (r.ok ? toast.success(r.message) : toast.error(r.message)),
    onError: (e: Error) => toast.error(e.message),
  });

  const saveNotifs = useMutation({
    mutationFn: async () => {
      const settingsR = await saveWhatsSettingsFn({ data: { settings: whatsDraft } });
      if (!settingsR.ok) return settingsR;
      return saveNotifsFn({ data: { notifications: notifDraft } });
    },
    onSuccess: (r) => {
      if (r.ok) {
        clearDirty();
        toast.success(r.message);
      } else toast.error(r.message);
      qc.invalidateQueries({ queryKey: ["whatsapp-notifications"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const uploadNotifImage = async (regra: string, file: File) => {
    const ext = file.name.split(".").pop() ?? "jpg";
    const path = `notificacoes/${regra}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from("whatsapp-notifications")
      .upload(path, file, { contentType: file.type, upsert: true });
    if (error) {
      toast.error(`Falha no upload: ${error.message}`);
      return;
    }
    const { data } = supabase.storage.from("whatsapp-notifications").getPublicUrl(path);
    const cur = notifDraft.find((n) => n.regra === regra);
    if (cur) upsertNotifDraft({ ...cur, imagem_url: data.publicUrl });
    toast.success("Imagem enviada com sucesso.");
  };

  const removeNotifImage = (regra: string) => {
    const cur = notifDraft.find((n) => n.regra === regra);
    if (cur) upsertNotifDraft({ ...cur, imagem_url: null });
  };

  const assignMotoboy = useMutation({
    mutationFn: (motoboyId: string | null) =>
      setMotoboyFn({ data: { orderId: selectedOrderId ?? "", motoboyId } }),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      qc.invalidateQueries({ queryKey: ["anota-orders"] });
      qc.invalidateQueries({ queryKey: ["anota-busca"] });
      qc.invalidateQueries({ queryKey: ["anota-order-detail"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sendMsg = useMutation({
    mutationFn: (tipo: NotifyType) => sendMsgFn({ data: { orderId: selectedOrderId ?? "", tipo } }),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      qc.invalidateQueries({ queryKey: ["anota-orders"] });
      qc.invalidateQueries({ queryKey: ["anota-order-detail"] });
      refetchWhatsNotifs();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const whatsStatus = useQuery({
    queryKey: ["whatsapp-status"],
    queryFn: () => whatsStatusFn(),
    refetchInterval: (query) => (query.state.data?.connected ? 60000 : 15000),
  });

  const whatsQr = useMutation({
    mutationFn: () => whatsQrFn(),
    onSuccess: (r) => {
      if (!r.ok) toast.error(r.message);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createSession = useMutation({
    mutationFn: () => createSessionFn(),
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(r.message);
        qc.invalidateQueries({ queryKey: ["whatsapp-status"] });
      } else {
        toast.error(r.message);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const hojeInicio = new Date();
  hojeInicio.setHours(0, 0, 0, 0);
  const hojeOrders = orders.filter((o) => new Date(o.imported_at) >= hojeInicio);
  const agendadosCount = scheduledWithPayload.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Anota AI"
        subtitle="Importe pedidos de venda e dê baixa automática no estoque"
        icon={ShoppingBag}
        actions={
          <>
            <div className="flex items-center gap-2">
              <Switch
                id="sync-toggle"
                checked={syncEnabled}
                onCheckedChange={(v) => setSyncEnabled(v)}
              />
              <Label htmlFor="sync-toggle" className="text-sm">
                {syncEnabled ? "Sync ativo" : "Sync desativado"}
              </Label>
            </div>
            <Button
              variant="outline"
              onClick={() => test.mutate()}
              disabled={test.isPending || !syncEnabled}
            >
              {test.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Plug className="mr-2 size-4" />
              )}
              Testar conexão
            </Button>
            <Select value={filtro} onValueChange={(v) => setFiltro(v as Filtro)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos os status</SelectItem>
                <SelectItem value="analise">Em análise</SelectItem>
                <SelectItem value="producao">Em produção</SelectItem>
                <SelectItem value="finalizados">Finalizados</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => sync.mutate()} disabled={sync.isPending || !syncEnabled}>
              {sync.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 size-4" />
              )}
              Sincronizar pedidos
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Pedidos importados" value={orders.length} icon={ShoppingBag} />
        <KpiCard
          label="Itens sem mapeamento"
          value={pendentes}
          icon={Link2}
          tone={pendentes ? "warning" : "success"}
          hint={pendentes ? "Vincule para permitir a baixa" : "Tudo mapeado"}
          onClick={() => setKpiDialog("pendentes")}
        />
        <KpiCard
          label="Finalizados sem baixa"
          value={finalizadosSemBaixa}
          icon={AlertTriangle}
          tone={finalizadosSemBaixa ? "warning" : "success"}
          onClick={() => setKpiDialog("semBaixa")}
        />
      </div>

      <Tabs value={tabValue} onValueChange={setTabValue}>
        <TabsList>
          <TabsTrigger value="pedidos">
            Pedidos{hojeOrders.length ? ` (${hojeOrders.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="agendados">
            Agendados{agendadosCount ? ` (${agendadosCount})` : ""}
          </TabsTrigger>
          <TabsTrigger value="buscar">Buscar pedidos</TabsTrigger>
          <TabsTrigger value="mapeamento">
            Mapeamento{pendentes ? ` (${pendentes})` : ""}
          </TabsTrigger>
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
          <TabsTrigger value="palavras">Palavras-chave</TabsTrigger>
        </TabsList>

        <TabsContent value="pedidos" className="pt-4">
          {hojeOrders.length === 0 ? (
            <EmptyState
              title="Nenhum pedido hoje"
              description="Os pedidos sincronizados hoje aparecerão aqui."
              icon={ShoppingBag}
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Pedido</th>
                    <th className="px-4 py-3">Cliente</th>
                    <th className="px-4 py-3">Data</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-center">Estoque</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {hojeOrders.map((o) => (
                    <tr key={o.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setSelectedOrderId(o.id)}
                          className="font-medium underline-offset-2 hover:underline cursor-pointer text-left"
                        >
                          {o.numero ?? o.external_order_id.slice(-6)}
                        </button>
                      </td>
                      <td className="px-4 py-3">{o.cliente ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {fmtDateTime(o.pedido_em ?? o.imported_at)}
                      </td>
                      <td className="px-4 py-3">
                        {o.check_status === -2
                          ? checkBadge(-2, getScheduledDate(o as any))
                          : checkBadge(o.check_status, null, !!o.sem_resposta_em)}
                      </td>
                      <td className="px-4 py-3 text-right tabular">{fmtMoney(o.total)}</td>
                      <td className="px-4 py-3 text-center">
                        {o.estoque_aplicado ? (
                          <CheckCircle2 className="mx-auto size-4 text-success" />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="agendados" className="pt-4">
          {agendadosCount === 0 ? (
            <EmptyState
              title="Nenhum pedido agendado"
              description="Pedidos com check_status = -2 (agendados) aparecerão aqui."
              icon={CalendarDays}
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Pedido</th>
                    <th className="px-4 py-3">Cliente</th>
                    <th className="px-4 py-3">Agendado para</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {scheduledWithPayload.map((o: any) => {
                    const scheduledDate = getScheduledDate(o.payload);
                    return (
                      <tr key={o.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setSelectedOrderId(o.id)}
                            className="font-medium underline-offset-2 hover:underline cursor-pointer text-left"
                          >
                            {o.numero ?? o.external_order_id.slice(-6)}
                          </button>
                        </td>
                        <td className="px-4 py-3">{o.cliente ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {scheduledDate ? fmtDateTime(scheduledDate) : "—"}
                        </td>
                        <td className="px-4 py-3">{checkBadge(-2, scheduledDate)}</td>
                        <td className="px-4 py-3 text-right tabular">{fmtMoney(o.total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="buscar" className="pt-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Search className="size-4 text-muted-foreground" />
              <input
                type="text"
                value={buscaTexto}
                onChange={(e) => setBuscaTexto(e.target.value)}
                placeholder="Buscar por cliente ou comanda"
                className="w-56 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <CalendarDays className="size-4 text-muted-foreground" />
              <input
                type="date"
                value={buscaData}
                onChange={(e) => setBuscaData(e.target.value)}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter className="size-4 text-muted-foreground" />
              <Select value={buscaStatus} onValueChange={(v) => setBuscaStatus(v as any)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todos">Todos</SelectItem>
                  <SelectItem value="producao">Em produção</SelectItem>
                  <SelectItem value="finalizados">Finalizados</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {buscaResults.length === 0 ? (
            <EmptyState
              title="Nenhum pedido encontrado"
              description={
                buscaTexto.trim()
                  ? `Nenhum pedido corresponde a "${buscaTexto}".`
                  : `Nenhum pedido sincronizado em ${new Date(buscaData).toLocaleDateString("pt-BR")}.`
              }
              icon={Search}
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Pedido</th>
                    <th className="px-4 py-3">Cliente</th>
                    <th className="px-4 py-3">Data</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-center">Estoque</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {buscaResults.map((o: any) => (
                    <tr key={o.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setSelectedOrderId(o.id)}
                          className="font-medium underline-offset-2 hover:underline cursor-pointer text-left"
                        >
                          {o.numero ?? o.external_order_id.slice(-6)}
                        </button>
                      </td>
                      <td className="px-4 py-3">{o.cliente ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {fmtDateTime(o.pedido_em ?? o.imported_at)}
                      </td>
                      <td className="px-4 py-3">{checkBadge(o.check_status, null, !!o.sem_resposta_em)}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtMoney(o.total)}</td>
                      <td className="px-4 py-3 text-center">
                        {o.estoque_aplicado ? (
                          <CheckCircle2 className="mx-auto size-4 text-success" />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="mapeamento" className="pt-4">
          {distinctItems.length === 0 ? (
            <EmptyState
              title="Nenhum item para mapear"
              description="Sincronize pedidos primeiro. Os itens vendidos aparecerão aqui para vincular aos seus produtos."
              icon={Link2}
            />
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Vincule cada item do cardápio do Anota AI a um produto do seu sistema. A baixa de
                estoque só é aplicada em pedidos finalizados com todos os itens mapeados.
              </p>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Item no Anota AI</th>
                      <th className="px-4 py-3 text-center">Ocorrências</th>
                      <th className="px-4 py-3">Produto do sistema</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {distinctItems.map((d) => {
                      const value = mapDraft[d.ref] ?? d.product_id ?? "none";
                      const hasRecipe = comboByRef.has(d.ref);
                      const comboItems = comboByRef.get(d.ref) ?? [];
                      return (
                        <tr key={d.ref} className="hover:bg-muted/30">
                          <td className="px-4 py-3">
                            <span className="font-medium">{d.nome ?? d.ref}</span>
                            {d.is_combo && (
                              <Badge variant="secondary" className="ml-2">
                                Combo
                              </Badge>
                            )}
                            {!d.product_id && !mapDraft[d.ref] && !hasRecipe && (
                              <Badge variant="outline" className="ml-2 text-warning">
                                Pendente
                              </Badge>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center text-muted-foreground">{d.count}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Select
                                value={value}
                                onValueChange={(v) => setMapDraft((s) => ({ ...s, [d.ref]: v }))}
                              >
                                <SelectTrigger className="w-64">
                                  <SelectValue placeholder="Selecionar produto..." />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">— Não vincular —</SelectItem>
                                  {products.map((p) => (
                                    <SelectItem key={p.id} value={p.id}>
                                      {p.nome}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button variant="outline" size="sm" onClick={() => openComboEditor(d.ref)}>
                                <Plus className="mr-1 size-3" />
                                {hasRecipe ? "Editar composição" : "Configurar composição"}
                              </Button>
                            </div>
                            {hasRecipe && (
                              <div className="mt-1 max-w-md truncate text-xs text-muted-foreground">
                                Composição:{" "}
                                {comboItems
                                  .map(
                                    (ci) =>
                                      `${products.find((p) => p.id === ci.product_id)?.nome ?? "?"} x${ci.quantidade}`,
                                  )
                                  .join(", ")}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => saveMap.mutate()} disabled={saveMap.isPending}>
                  {saveMap.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Salvar mapeamento
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="whatsapp" className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Notificações WhatsApp</h3>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Envia automaticamente para clientes (e motoboys vinculados) quando os pedidos do
                Anota entram ou ficam prontos. Requer o Waha configurado nas variáveis de ambiente.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => testWhats.mutate()}
              disabled={testWhats.isPending}
            >
              {testWhats.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Plug className="mr-2 size-4" />
              )}
              Testar conexão
            </Button>
          </div>

          <div className="rounded-xl border border-border p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold">Conexão do número</h4>
                <p className="text-xs text-muted-foreground">
                  {whatsStatus.data?.sessionName
                    ? `Sessão: ${whatsStatus.data.sessionName}`
                    : "Conecte o número do WhatsApp escaneando o QR Code."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {whatsStatus.isFetching ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : whatsStatus.data?.connected ? (
                  <Badge variant="default" className="gap-1 bg-green-600">
                    <CheckCircle2 className="size-3" /> Conectado
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1">
                    <AlertTriangle className="size-3" /> Desconectado
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => whatsStatus.refetch()}
                  disabled={whatsStatus.isFetching}
                  title="Atualizar status"
                >
                  <RefreshCw className="size-4" />
                </Button>
              </div>
            </div>

            {!whatsStatus.data?.connected ? (
              <div className="flex flex-col items-center gap-3">
                {whatsQr.data?.qrDataUrl ? (
                  <img
                    src={whatsQr.data.qrDataUrl}
                    alt="QR Code WhatsApp"
                    className="h-52 w-52 rounded border border-border bg-white object-contain"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Nenhum QR Code exibido ainda. Clique em "Gerar QR Code".
                  </p>
                )}
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => whatsQr.mutate()}
                    disabled={whatsQr.isPending}
                  >
                    {whatsQr.isPending ? (
                      <Loader2 className="mr-1 size-4 animate-spin" />
                    ) : (
                      <QrCode className="mr-1 size-4" />
                    )}
                    Gerar QR Code
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => createSession.mutate()}
                    disabled={createSession.isPending}
                  >
                    {createSession.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
                    Criar sessão
                  </Button>
                </div>
                <p className="max-w-md text-center text-xs text-muted-foreground">
                  No celular, abra o WhatsApp → Configurações → Aparelhos conectados → Conectar um
                  aparelho e escaneie o QR Code. O número conectado será o remetente das
                  notificações.
                </p>
                {whatsStatus.data && !whatsStatus.data.ok && (
                  <p className="max-w-md text-center text-xs font-medium text-destructive">
                    {whatsStatus.data.message}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Número conectado e pronto para enviar notificações de pedidos.
              </p>
            )}
          </div>

          <div className="space-y-4 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-medium">Notificações automáticas</Label>
                <p className="text-xs text-muted-foreground">
                  Cada notificação tem um título, a mensagem, a regra de disparo e uma imagem
                  opcional enviada junto com o texto. Ative/desative o envio automático durante a
                  sincronização de pedidos.
                </p>
              </div>
              <Switch
                checked={whatsDraft.whatsapp_enabled === "true"}
                onCheckedChange={(v) =>
                  setWhatsDraft((s) => ({ ...s, whatsapp_enabled: v ? "true" : "false" }))
                }
              />
            </div>

            {notifDraft.map((notif) => {
              const isFixed = FIXED_NOTIFICATION_REGRAS.includes(
                notif.regra as (typeof FIXED_NOTIFICATION_REGRAS)[number],
              );
              const fixedTitle = DEFAULT_NOTIF_TITLES[notif.regra];
              return (
                <div key={notif.regra} className="space-y-3 rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs">Ativa</Label>
                      <Switch
                        checked={notif.ativo}
                        onCheckedChange={(v) => upsertNotifDraft({ ...notif, ativo: v })}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {notif.regra}
                      </Badge>
                      {!isFixed && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="size-7 p-0"
                          onClick={() => removeNotifDraft(notif.regra)}
                          title="Remover notificação"
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Título</Label>
                    <input
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      value={notif.titulo || fixedTitle || notif.regra}
                      onChange={(e) => upsertNotifDraft({ ...notif, titulo: e.target.value })}
                      placeholder={fixedTitle ?? "Nome da notificação"}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Mensagem</Label>
                    <Textarea
                      value={notif.mensagem}
                      onChange={(e) => upsertNotifDraft({ ...notif, mensagem: e.target.value })}
                      rows={3}
                      placeholder="Texto enviado ao cliente/motoboy..."
                    />
                    <p className="text-xs text-muted-foreground">
                      Variáveis disponíveis: {TEMPLATE_VARIABLES.join("  ")}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Regra de disparo</Label>
                    {isFixed ? (
                      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                        {notif.regra === "pedido_recebido" &&
                          "Enviada automaticamente quando um pedido entra."}
                        {notif.regra === "pedido_pronto" &&
                          "Enviada automaticamente quando um pedido fica pronto (cliente)."}
                        {notif.regra === "motoboy" &&
                          "Enviada automaticamente quando o pedido fica pronto (motoboy vinculado)."}
                      </p>
                    ) : (
                      <Select
                        value={String(notif.status ?? "")}
                        onValueChange={(v) => {
                          const status = Number(v);
                          upsertNotifDraft({ ...notif, status, regra: `status_${status}` });
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Selecionar status..." />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_MESSAGE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={String(opt.value)}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Imagem (opcional)</Label>
                    <div className="flex flex-wrap items-center gap-3">
                      {notif.imagem_url ? (
                        <>
                          <img
                            src={notif.imagem_url}
                            alt="Imagem da notificação"
                            className="h-16 w-16 rounded border border-border object-cover"
                          />
                          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
                            <ImagePlus className="size-4" />
                            Trocar imagem
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) uploadNotifImage(notif.regra, f);
                                e.target.value = "";
                              }}
                            />
                          </label>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="size-7 p-0"
                            onClick={() => removeNotifImage(notif.regra)}
                            title="Remover imagem"
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </>
                      ) : (
                        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-1.5 text-xs hover:bg-accent">
                          <ImagePlus className="size-4" />
                          Enviar imagem
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) uploadNotifImage(notif.regra, f);
                              e.target.value = "";
                            }}
                          />
                        </label>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  upsertNotifDraft({
                    id: "",
                    regra: `status_${STATUS_MESSAGE_OPTIONS[0]?.value ?? 0}`,
                    titulo: "Status do pedido",
                    mensagem: "",
                    status: STATUS_MESSAGE_OPTIONS[0]?.value ?? 0,
                    imagem_url: null,
                    ativo: true,
                  })
                }
              >
                <Plus className="mr-1 size-4" /> Adicionar notificação de status
              </Button>

              <Button onClick={() => saveNotifs.mutate()} disabled={saveNotifs.isPending}>
                {saveNotifs.isPending ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Save className="mr-2 size-4" />
                )}
                Salvar notificações
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="palavras" className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold">Regras por palavras-chave</h3>
            <Button
              size="sm"
              className="bg-yellow-500 text-black hover:bg-yellow-600"
              onClick={() => setShowRulesHelp(true)}
            >
              Ver regras
            </Button>
          </div>

          <Dialog open={showRulesHelp} onOpenChange={setShowRulesHelp}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Regras por palavras-chave</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  Quando o pedido sincronizado contiver uma das palavras-chave nos itens, no nome do
                  cliente ou no payload, a mensagem configurada é enviada automaticamente ao cliente.
                </p>
                <p>
                  Suporta as variáveis:{" "}
                  <span className="font-mono text-xs">{TEMPLATE_VARIABLES.join(", ")}</span>.
                </p>
              </div>
            </DialogContent>
          </Dialog>

          {keywordDraft.length === 0 ? (
            <EmptyState
              title="Nenhuma regra configurada"
              description="Crie uma regra para disparar mensagens por palavras-chave."
              icon={Filter}
            />
          ) : (
            keywordDraft.map((rule) => (
              <div key={rule.regra} className="space-y-3 rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">Ativa</Label>
                    <Switch
                      checked={rule.ativo}
                      onCheckedChange={(v) => upsertKeywordRule({ ...rule, ativo: v })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">Alerta sonoro</Label>
                    <Switch
                      checked={rule.alerta_sonoro ?? true}
                      onCheckedChange={(v) => upsertKeywordRule({ ...rule, alerta_sonoro: v })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {rule.regra}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="size-7 p-0"
                      onClick={() => removeKeywordRule(rule.regra)}
                      title="Remover regra"
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Nome da regra</Label>
                  <input
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    value={rule.nome}
                    onChange={(e) => upsertKeywordRule({ ...rule, nome: e.target.value })}
                    placeholder="Ex.: Cliente fiel"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Palavras-chave (separadas por vírgula)</Label>
                  <Textarea
                    value={rule.palavras_chave}
                    onChange={(e) =>
                      upsertKeywordRule({ ...rule, palavras_chave: e.target.value })
                    }
                    rows={2}
                    placeholder="Ex.: bolo, brigadeiro, festa"
                  />
                  <p className="text-xs text-muted-foreground">
                    A regra dispara se QUALQUER palavra-chave aparecer no pedido (não diferencia
                    maiúsculas/minúsculas).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Mensagem</Label>
                  <Textarea
                    value={rule.mensagem}
                    onChange={(e) => upsertKeywordRule({ ...rule, mensagem: e.target.value })}
                    rows={3}
                    placeholder="Texto enviado ao cliente quando a regra dispara..."
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Imagem (opcional)</Label>
                  <div className="flex flex-wrap items-center gap-3">
                    {rule.imagem_url ? (
                      <>
                        <img
                          src={rule.imagem_url}
                          alt="Imagem da regra"
                          className="h-16 w-16 rounded border border-border object-cover"
                        />
                        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
                          <ImagePlus className="size-4" />
                          Trocar imagem
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) uploadKeywordImage(rule.regra, f);
                              e.target.value = "";
                            }}
                          />
                        </label>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="size-7 p-0"
                          onClick={() => removeKeywordImage(rule.regra)}
                          title="Remover imagem"
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </>
                    ) : (
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-1.5 text-xs hover:bg-accent">
                        <ImagePlus className="size-4" />
                        Enviar imagem
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) uploadKeywordImage(rule.regra, f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const slug = slugify("nova-regra-" + Date.now());
                upsertKeywordRule({
                  id: "",
                  regra: slug,
                  nome: "Nova regra",
                  palavras_chave: "",
                  mensagem: "",
                  imagem_url: null,
                  ativo: true,
                  alerta_sonoro: true,
                });
              }}
            >
              <Plus className="mr-1 size-4" /> Adicionar regra
            </Button>

            <Button
              onClick={() => saveKeywordRules.mutate()}
              disabled={saveKeywordRules.isPending}
            >
              {saveKeywordRules.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Save className="mr-2 size-4" />
              )}
              Salvar regras
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={!!selectedOrderId} onOpenChange={(open) => !open && setSelectedOrderId(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Pedido {selectedOrder?.numero ?? selectedOrder?.external_order_id?.slice(-6) ?? ""}
            </DialogTitle>
          </DialogHeader>
          {selectedOrder && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Cliente:</span>{" "}
                  <span className="font-medium">{selectedOrder.cliente ?? "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Data:</span>{" "}
                  <span className="font-medium">
                    {fmtDateTime(selectedOrder.pedido_em ?? selectedOrder.imported_at)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>{" "}
                  {checkBadge(selectedOrder.check_status, null, !!selectedOrder.sem_resposta_em)}
                </div>
                <div>
                  <span className="text-muted-foreground">Total:</span>{" "}
                  <span className="font-medium">{fmtMoney(selectedOrder.total)}</span>
                </div>
              </div>
              <div className="border-t pt-3">
                <h4 className="mb-2 text-sm font-medium">Itens do pedido</h4>
                {orderItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nenhum item encontrado. Sincronize novamente os pedidos.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2 text-right">Qtd</th>
                        <th className="px-3 py-2 text-right">Ações</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {orderDraft.map((it, i) => (
                        <tr key={it.id ?? i}>
                          <td className="px-3 py-2">
                            <Input
                              value={it.nome ?? ""}
                              onChange={(e) => setOrderDraft((draft) => draft.map((row, index) => index === i ? { ...row, nome: e.target.value } : row))}
                              className="h-8 min-w-40"
                              aria-label="Nome do item"
                            />
                            {it.is_combo && <Badge variant="secondary" className="ml-2">Combo</Badge>}
                            {it.combo_ref && <span className="ml-2 text-xs text-muted-foreground">Item do combo</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <Input
                              type="number"
                              min="0.01"
                              step="0.01"
                              value={it.quantidade ?? ""}
                              onChange={(e) => setOrderDraft((draft) => draft.map((row, index) => index === i ? { ...row, quantidade: e.target.value } : row))}
                              className="h-8 w-20"
                              aria-label="Quantidade do item"
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex justify-end gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Excluir item"
                              aria-label="Excluir item"
                              onClick={() => setOrderDraft((draft) => draft.filter((_, index) => index !== i))}
                            >
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                            {(it.is_combo || comboByRef.has(it.anota_item_ref ?? "")) && it.anota_item_ref ? (
                              <Button size="sm" variant="outline" onClick={() => openComboEditor(it.anota_item_ref)}>
                                <Link2 className="mr-1 size-3" />
                                {comboByRef.has(it.anota_item_ref) ? "Editar combo" : "Mapear combo"}
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="mt-3 flex flex-wrap justify-between gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setOrderDraft((draft) => [...draft, { nome: "", quantidade: 1, product_id: null, is_combo: false, combo_ref: null }])}
                  >
                    <Plus className="mr-1 size-4" /> Adicionar item
                  </Button>
                  <Button size="sm" onClick={() => saveOrderItems.mutate()} disabled={saveOrderItems.isPending}>
                    {saveOrderItems.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
                    Salvar itens
                  </Button>
                </div>
              </div>

              <div className="space-y-3 border-t pt-3">
                <h4 className="text-sm font-medium">Entrega (WhatsApp)</h4>
                <div className="space-y-1.5">
                  <Label className="text-xs">Motoboy (colaborador)</Label>
                  <Select
                    value={selectedDetail?.motoboy_id ?? "none"}
                    onValueChange={(v) => assignMotoboy.mutate(v === "none" ? null : v)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Selecionar motoboy..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Nenhum —</SelectItem>
                      {collaborators.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.nome}
                          {c.cargo ? ` (${c.cargo})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => sendMsg.mutate("recebido")}
                    disabled={sendMsg.isPending}
                  >
                    <Send className="mr-1 size-3" /> Confirmar pedido
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => sendMsg.mutate("pronto")}
                    disabled={sendMsg.isPending}
                  >
                    <Send className="mr-1 size-3" /> Pedido pronto
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => sendMsg.mutate("motoboy")}
                    disabled={sendMsg.isPending || !selectedDetail?.motoboy_id}
                  >
                    <Send className="mr-1 size-3" /> Notificar motoboy
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!comboEditingRef}
        onOpenChange={(open) => {
          if (!open) setComboEditingRef(null);
        }}
      >
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Composição — {comboEditingNome}</DialogTitle>
          </DialogHeader>
          <p className="-mt-2 text-sm text-muted-foreground">
            Defina os produtos e quantidades que compõem este combo. Ao finalizar um pedido com
            este combo, a baixa de estoque usa essa composição.
          </p>
          <div className="space-y-2">
            {comboDraft.map((row, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Select
                  value={row.product_id}
                  onValueChange={(v) =>
                    setComboDraft((d) =>
                      d.map((r, i) => (i === idx ? { ...r, product_id: v } : r)),
                    )
                  }
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Selecionar produto..." />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.nome}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  className="w-24"
                  value={row.quantidade}
                  onChange={(e) =>
                    setComboDraft((d) =>
                      d.map((r, i) => (i === idx ? { ...r, quantidade: e.target.value } : r)),
                    )
                  }
                  placeholder="Qtd"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setComboDraft((d) => d.filter((_, i) => i !== idx))
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setComboDraft((d) => [...d, { product_id: "", quantidade: "" }])}
            >
              <Plus className="mr-1 size-4" /> Adicionar produto
            </Button>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setComboEditingRef(null)}>
              Cancelar
            </Button>
            <Button onClick={() => saveCombo.mutate()} disabled={saveCombo.isPending}>
              {saveCombo.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Salvar composição
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: Itens sem mapeamento */}
      <Dialog
        open={kpiDialog === "pendentes"}
        onOpenChange={(open) => !open && setKpiDialog(null)}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Itens sem mapeamento ({pendentes})</DialogTitle>
          </DialogHeader>
          <p className="-mt-2 text-sm text-muted-foreground">
            Estes itens não têm produto vinculado nem composição de combo configurada. A baixa de
            estoque não será aplicada enquanto estiverem pendentes.
          </p>
          {pendentesItems.length > 0 ? (
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Item no Anota AI</th>
                    <th className="px-4 py-3 text-center">Ocorrências</th>
                    <th className="px-4 py-3">Tipo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pendentesItems.map((d) => (
                    <tr key={d.ref} className="hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">{d.nome ?? d.ref}</td>
                      <td className="px-4 py-3 text-center text-muted-foreground">{d.count}</td>
                      <td className="px-4 py-3">
                        {d.is_combo ? (
                          <Badge variant="secondary">Combo</Badge>
                        ) : (
                          <Badge variant="outline">Item simples</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">Nenhum item pendente.</div>
          )}
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t">
            <Button variant="outline" onClick={() => setKpiDialog(null)}>
              Fechar
            </Button>
            <Button
              onClick={() => {
                setKpiDialog(null);
                setTabValue("mapeamento");
              }}
            >
              Ir para mapeamento
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: Finalizados sem baixa */}
      <Dialog
        open={kpiDialog === "semBaixa"}
        onOpenChange={(open) => !open && setKpiDialog(null)}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Finalizados sem baixa ({finalizadosSemBaixa})</DialogTitle>
          </DialogHeader>
          <p className="-mt-2 text-sm text-muted-foreground">
            Pedidos com status finalizado (check_status = 3) mas sem estoque_aplicado. Verifique
            itens sem mapeamento ou falhas na sincronização.
          </p>
          {finalizadosSemBaixaItems.length > 0 ? (
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Pedido</th>
                    <th className="px-4 py-3">Cliente</th>
                    <th className="px-4 py-3">Data</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-center">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {finalizadosSemBaixaItems.map((o) => (
                    <tr key={o.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => {
                            setSelectedOrderId(o.id);
                            setKpiDialog(null);
                          }}
                          className="font-medium underline-offset-2 hover:underline cursor-pointer text-left"
                        >
                          {o.numero ?? o.external_order_id.slice(-6)}
                        </button>
                      </td>
                      <td className="px-4 py-3">{o.cliente ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {fmtDateTime(o.pedido_em ?? o.imported_at)}
                      </td>
                      <td className="px-4 py-3 text-right tabular">{fmtMoney(o.total)}</td>
                      <td className="px-4 py-3 text-center">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSelectedOrderId(o.id);
                            setKpiDialog(null);
                          }}
                        >
                          Ver detalhes
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">Nenhum pedido sem baixa.</div>
          )}
          <div className="flex justify-end mt-4 pt-4 border-t">
            <Button variant="outline" onClick={() => setKpiDialog(null)}>
              Fechar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
