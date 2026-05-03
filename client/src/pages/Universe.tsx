import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Search, Globe, Filter, RefreshCw } from "lucide-react";
import { usePermission } from "@/lib/permissionContext";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";

interface Stock {
  id: number; ticker: string; name: string; exchange: string; country: string;
  region: string; currency: string; sector: string | null; assetType: string; isActive: boolean;
}

interface Watchlist {
  id: number; name: string; description: string; tickers: string; createdAt: string;
}

const addStockSchema = z.object({
  ticker: z.string().min(1).max(12).transform((v) => v.toUpperCase()),
  name: z.string().min(2),
  exchange: z.string().min(2),
  country: z.string().min(2).max(4),
  region: z.enum(["Americas", "Europe", "Asia", "Global"]),
  currency: z.string().min(3).max(3),
  sector: z.string().optional(),
  assetType: z.enum(["stock", "etf"]).default("stock"),
});

type AddStockForm = z.infer<typeof addStockSchema>;

const EXCHANGES = ["NASDAQ", "NYSE", "XETRA", "LSE", "EURONEXT", "TSX", "TSE", "HKEX", "ASX", "OTC", "Other"];
const REGIONS = ["Americas", "Europe", "Asia", "Global"];
const SECTORS = [
  "Technology", "Financials", "Healthcare", "Defense & Aerospace", "Industrials",
  "Energy – Oil & Gas", "Clean Energy", "Nuclear", "Automotive", "Retail & Leisure",
  "Consumer Staples", "Communication Services", "Materials", "Real Estate",
  "Utilities", "Crypto & Digital Assets",
];

export default function Universe() {
  const [search, setSearch] = useState("");
  const [regionFilter, setRegionFilter] = useState("all");
  const [exchangeFilter, setExchangeFilter] = useState("all");
  const [assetTypeFilter, setAssetTypeFilter] = useState("all");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showAddWatchlist, setShowAddWatchlist] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();
  const permissionType = usePermission();

  const { data: stocks = [], isLoading } = useQuery<Stock[]>({
    queryKey: ["/api/universe"],
    refetchInterval: 30000,
  });

  const { data: watchlists = [] } = useQuery<Watchlist[]>({
    queryKey: ["/api/watchlists"],
  });

  const addMutation = useMutation({
    mutationFn: (data: AddStockForm) => apiRequest("POST", "/api/universe", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/universe"] });
      setShowAddDialog(false);
      toast({ title: "Stock added to universe" });
    },
    onError: (err: any) => toast({ title: "Failed to add", description: err.message, variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: (ticker: string) => apiRequest("DELETE", `/api/universe/${ticker}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/universe"] });
      toast({ title: "Removed from universe" });
    },
  });

  const addWatchlistMutation = useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      apiRequest("POST", "/api/watchlists", { ...data, tickers: "[]" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/watchlists"] });
      setShowAddWatchlist(false);
      toast({ title: "Watchlist created" });
    },
  });

  const deleteWatchlistMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/watchlists/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/watchlists"] }),
  });

  const form = useForm<AddStockForm>({
    resolver: zodResolver(addStockSchema),
    defaultValues: { ticker: "", name: "", exchange: "NASDAQ", country: "US", region: "Americas", currency: "USD", assetType: "stock" },
  });

  const [wlName, setWlName] = useState("");

  // Filter stocks
  const filtered = stocks.filter((s) => {
    if (!s.isActive) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!s.ticker.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) return false;
    }
    if (regionFilter !== "all" && s.region !== regionFilter) return false;
    if (exchangeFilter !== "all" && s.exchange !== exchangeFilter) return false;
    if (assetTypeFilter !== "all" && s.assetType !== assetTypeFilter) return false;
    return true;
  });

  // Group by region
  const byRegion = filtered.reduce((acc, s) => {
    acc[s.region] = acc[s.region] || [];
    acc[s.region].push(s);
    return acc;
  }, {} as Record<string, Stock[]>);

  return (
    <div className="p-4 space-y-4" data-testid="page-universe">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-base font-semibold text-foreground">Universe & Watchlists</h1>
          <p className="text-xs text-muted-foreground">{stocks.filter((s) => s.isActive).length} active stocks across all exchanges</p>
        </div>
        {permissionType === "admin" && (
          <Button
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => setShowAddDialog(true)}
            data-testid="button-add-stock"
          >
            <Plus className="w-3.5 h-3.5" /> Add Stock
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-40">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input placeholder="Search ticker or name…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 h-8 text-sm" />
        </div>
        <Select value={regionFilter} onValueChange={setRegionFilter}>
          <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="Region" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All regions</SelectItem>
            {REGIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={exchangeFilter} onValueChange={setExchangeFilter}>
          <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="Exchange" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All exchanges</SelectItem>
            {EXCHANGES.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={assetTypeFilter} onValueChange={setAssetTypeFilter}>
          <SelectTrigger className="h-8 w-24 text-xs"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="stock">Stocks</SelectItem>
            <SelectItem value="etf">ETFs</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Universe table */}
        <div className="xl:col-span-2">
          <Card className="bg-card border-border">
            <CardHeader className="p-3 pb-2 border-b border-border flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">Universe ({filtered.length})</CardTitle>
              <Badge variant="outline" className="text-[10px]">{filtered.length} shown</Badge>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                <table className="w-full text-xs min-w-[500px]">
                  <thead className="sticky-thead border-b border-border">
                    <tr className="text-[10px] text-muted-foreground">
                      <th className="px-3 py-2 text-left">TICKER</th>
                      <th className="px-2 py-2 text-left">NAME</th>
                      <th className="px-2 py-2 text-left">EXCHANGE</th>
                      <th className="px-2 py-2 text-left">REGION</th>
                      <th className="px-2 py-2 text-left">SECTOR</th>
                      <th className="px-2 py-2 text-center">TYPE</th>
                      <th className="px-2 py-2 text-center">ACTION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading && Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i} className="border-b border-border">
                        {Array.from({ length: 7 }).map((_, j) => (
                          <td key={j} className="px-3 py-2"><Skeleton className="h-3.5 w-full" /></td>
                        ))}
                      </tr>
                    ))}
                    {!isLoading && filtered.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                          <Globe className="w-6 h-6 mx-auto mb-1 opacity-30" />
                          No stocks match your filters
                        </td>
                      </tr>
                    )}
                    {!isLoading && filtered.map((s) => (
                      <tr key={s.id} className="border-b border-border last:border-0 hover:bg-secondary/50 transition-colors" data-testid={`row-universe-${s.ticker}`}>
                        <td className="px-3 py-2 font-semibold text-foreground tabular-nums">{s.ticker}</td>
                        <td className="px-2 py-2 text-muted-foreground max-w-[160px] truncate">{s.name}</td>
                        <td className="px-2 py-2 text-muted-foreground">{s.exchange}</td>
                        <td className="px-2 py-2 text-muted-foreground">{s.region}</td>
                        <td className="px-2 py-2 text-muted-foreground max-w-[120px] truncate">{s.sector ?? "—"}</td>
                        <td className="px-2 py-2 text-center">
                          <Badge variant="outline" className="text-[9px] h-4 px-1">
                            {s.assetType.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="px-2 py-2 text-center">
                          {permissionType === "admin" && (
                            <button
                              onClick={() => removeMutation.mutate(s.ticker)}
                              disabled={removeMutation.isPending}
                              className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors"
                              data-testid={`button-remove-${s.ticker}`}
                              title="Remove from universe"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Watchlists panel */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Watchlists</h2>
            {permissionType === "admin" && (
              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setShowAddWatchlist(true)}>
                <Plus className="w-3 h-3" /> New
              </Button>
            )}
          </div>

          {watchlists.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="p-4 text-center text-muted-foreground">
                <div className="text-xs">No watchlists yet.</div>
                <div className="text-[10px] mt-1">Create one to group stocks for quick monitoring.</div>
              </CardContent>
            </Card>
          ) : (
            watchlists.map((wl) => {
              const tickers = (() => { try { return JSON.parse(wl.tickers) as string[]; } catch { return []; } })();
              return (
                <Card key={wl.id} className="bg-card border-border">
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-foreground">{wl.name}</span>
                      {permissionType === "admin" && (
                        <button
                          onClick={() => deleteWatchlistMutation.mutate(wl.id)}
                          className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {wl.description && <div className="text-[10px] text-muted-foreground mb-2">{wl.description}</div>}
                    <div className="flex flex-wrap gap-1">
                      {tickers.length === 0 ? (
                        <span className="text-[10px] text-muted-foreground italic">No tickers added yet</span>
                      ) : (
                        tickers.map((t) => (
                          <Badge key={t} variant="secondary" className="text-[10px] h-5 font-mono">{t}</Badge>
                        ))
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-2">{tickers.length} tickers</div>
                  </CardContent>
                </Card>
              );
            })
          )}

          {/* Exchange coverage */}
          <Card className="bg-card border-border">
            <CardHeader className="p-3 pb-2 border-b border-border">
              <CardTitle className="text-xs font-semibold text-muted-foreground">SUPPORTED EXCHANGES</CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              <div className="space-y-1.5 text-xs">
                {[
                  { name: "NASDAQ / NYSE", region: "🇺🇸 US", note: "Full coverage" },
                  { name: "XETRA", region: "🇩🇪 Germany", note: "ADR/OTC tickers" },
                  { name: "LSE", region: "🇬🇧 UK", note: "ADR tickers" },
                  { name: "EURONEXT", region: "🇪🇺 Europe", note: "ADR/OTC tickers" },
                  { name: "OTC Markets", region: "🌍 Global", note: "Pink/OTC tickers" },
                  { name: "ETFs", region: "🌐 Global", note: "Any ETF on US exchanges" },
                ].map(({ name, region, note }) => (
                  <div key={name} className="flex items-center justify-between">
                    <div>
                      <span className="text-foreground font-medium">{name}</span>
                      <span className="text-muted-foreground ml-2">{region}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{note}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 p-2 rounded bg-secondary text-[10px] text-muted-foreground">
                European stocks are accessed as ADR or OTC tickers (e.g., SIEGY for Siemens).
                Local exchange tickers require a paid data provider.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Add Stock Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Stock to Universe</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((d) => addMutation.mutate(d))} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="ticker" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Ticker Symbol</FormLabel>
                    <FormControl><Input placeholder="AAPL" className="h-8 text-sm" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="assetType" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl><SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="stock">Stock</SelectItem>
                        <SelectItem value="etf">ETF</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Company Name</FormLabel>
                  <FormControl><Input placeholder="Apple Inc." className="h-8 text-sm" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="exchange" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Exchange</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl><SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {EXCHANGES.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
                <FormField control={form.control} name="region" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Region</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl><SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {REGIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <FormField control={form.control} name="country" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Country</FormLabel>
                    <FormControl><Input placeholder="US" className="h-8 text-sm" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="currency" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Currency</FormLabel>
                    <FormControl><Input placeholder="USD" className="h-8 text-sm" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="sector" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Sector</FormLabel>
                    <Select onValueChange={field.onChange}>
                      <FormControl><SelectTrigger className="h-8 text-sm"><SelectValue placeholder="—" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {SECTORS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowAddDialog(false)}>Cancel</Button>
                <Button type="submit" size="sm" disabled={addMutation.isPending}>
                  {addMutation.isPending ? "Adding…" : "Add to Universe"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Add Watchlist Dialog */}
      <Dialog open={showAddWatchlist} onOpenChange={setShowAddWatchlist}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Create Watchlist</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Name</label>
              <Input value={wlName} onChange={(e) => setWlName(e.target.value)} placeholder="My Watchlist" className="h-8 text-sm" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAddWatchlist(false)}>Cancel</Button>
            <Button size="sm" disabled={!wlName || addWatchlistMutation.isPending}
              onClick={() => addWatchlistMutation.mutate({ name: wlName })}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
