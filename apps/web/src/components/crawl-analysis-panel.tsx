import React from "react";
import { CaretDown, CaretRight, Funnel, FlowArrow, ArrowLeft } from "@phosphor-icons/react";
import { CrawlRunStatusPanel } from "@/components/crawl-run-status-panel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCost, formatMs } from "@/lib/formatters";

type LLMStoredContentPart =
  | { type: "text"; text: string }
  | { type: "image"; imageIndex: number; label?: string };

type LLMStoredMessage = {
  role: string;
  content: string | LLMStoredContentPart[];
};

export type CrawlLlmCallRecord = {
  seq: number;
  stepIndex: number;
  model: string;
  hasVision: boolean;
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  costUsd: number;
  query?: string;
  requestMessages?: LLMStoredMessage[];
  response: string;
  agent?: string;
  crawlContext?: Record<string, unknown>;
};

export type CrawlMetadataJson = {
  baseUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  limits?: {
    maxCrawlPages?: number;
    maxAppRoutes?: number;
    maxDepth?: number;
    crawlDelayMs?: number;
    routeFilterBatchSize?: number;
    maxInteractionsPerPage?: number;
  };
  stats?: {
    pagesVisited?: number;
    nodesFound?: number;
    suggestedFlowsCount?: number;
    llmCallCount?: number;
  };
  error?: string;
  diagnostics?: {
    bfsPagesDiscovered: number;
    afterShallowTrim: number;
    afterRouteFilter: number;
    hints: string[];
  };
  phase?: string;
  inProgress?: boolean;
};

function CrawlLlmCallCard({ call }: { call: CrawlLlmCallRecord }) {
  const [expanded, setExpanded] = React.useState(false);
  const agent = call.agent ?? "";
  const isRouteFilter = agent === "crawl_route_filter" || agent === "crawl_link_filter";
  const isFlows = agent === "crawl_suggested_flows";

  return (
    <Card
      className={cn(
        "overflow-visible transition-colors",
        isRouteFilter && "border-l-2 border-l-teal-500/40",
        isFlows && "border-l-2 border-l-amber-500/40",
      )}
    >
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-[10px] font-mono text-muted-foreground/50 w-5 text-right flex-shrink-0">{call.seq}</span>
        {isRouteFilter && <Funnel className="h-3 w-3 text-teal-400 flex-shrink-0" />}
        {isFlows && <FlowArrow className="h-3 w-3 text-amber-400 flex-shrink-0" />}
        <span className="text-[10px] font-medium text-muted-foreground uppercase flex-shrink-0">
          {isRouteFilter ? "Route filter" : isFlows ? "Suggested flows" : agent}
        </span>
        <span className="text-[11px] text-foreground truncate flex-1 min-w-0">{call.model}</span>
        <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-14 text-right flex-shrink-0">
          {call.inputTokens.toLocaleString()}
        </span>
        <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-14 text-right flex-shrink-0">
          {call.outputTokens.toLocaleString()}
        </span>
        <span className="text-[11px] font-mono tabular-nums w-16 text-right flex-shrink-0">{formatCost(call.costUsd)}</span>
        <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-12 text-right flex-shrink-0">
          {formatMs(call.durationMs)}
        </span>
        {expanded ? (
          <CaretDown className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
        ) : (
          <CaretRight className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-border/50 space-y-3">
          {call.query && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1">Summary</p>
              <p className="text-[11px] font-mono text-muted-foreground">{call.query}</p>
            </div>
          )}
          {call.crawlContext && Object.keys(call.crawlContext).length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1">Context</p>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 p-2 text-foreground/80">
                {JSON.stringify(call.crawlContext, null, 2)}
              </pre>
            </div>
          )}
          {call.requestMessages && call.requestMessages.length > 0 && (
            <div className="space-y-2 min-h-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">Request</p>
              <div className="max-h-[min(48vh,420px)] min-h-[8rem] overflow-y-auto rounded-md border border-border bg-muted/20 [scrollbar-gutter:stable]">
                <div className="p-3 space-y-3">
                  {call.requestMessages.map((m, mi) => (
                    <div key={mi} className="space-y-2">
                      <Badge variant="outline" className="text-[10px] font-mono uppercase h-5">
                        {m.role}
                      </Badge>
                      {typeof m.content === "string" ? (
                        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/80 leading-relaxed">
                          {m.content}
                        </pre>
                      ) : (
                        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/80">
                          {JSON.stringify(m.content, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {call.response ? (
            <div className="space-y-2 min-h-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">Response</p>
              <div className="h-[min(48vh,420px)] min-h-[10rem] overflow-y-auto overflow-x-auto rounded-md border border-border bg-muted/20 [scrollbar-gutter:stable]">
                <pre className="block w-full min-w-0 text-[11px] font-mono whitespace-pre-wrap break-words p-3 text-foreground/80 leading-relaxed">
                  {call.response}
                </pre>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

type CrawlAnalysisPanelProps = {
  metadata: CrawlMetadataJson | null | undefined;
  llmCalls: CrawlLlmCallRecord[] | null | undefined;
  onBack: () => void;
};

export function CrawlAnalysisPanel({ metadata, llmCalls, onBack }: CrawlAnalysisPanelProps) {
  const calls = Array.isArray(llmCalls) ? llmCalls : [];
  const llmTotalUsd = calls.reduce((s, c) => s + (typeof c.costUsd === "number" ? c.costUsd : 0), 0);

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-2 px-1 pb-2 shrink-0 border-b border-border">
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 -ml-1" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Runs
        </Button>
      </div>
      <Tabs defaultValue="overview" className="flex flex-col flex-1 min-h-0 mt-2">
        <TabsList className="shrink-0">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="llm">
            LLM ({calls.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex-1 min-h-0 overflow-y-auto mt-0 pt-3 space-y-3 data-[state=inactive]:hidden">
          {metadata ? (
            <>
              <CrawlRunStatusPanel
                variant="summary"
                title="Run overview"
                run={{
                  status: metadata.error ? "failed" : "completed",
                  started_at: metadata.startedAt ?? metadata.finishedAt ?? "",
                  completed_at: metadata.finishedAt ?? null,
                  pages_visited: metadata.stats?.pagesVisited ?? null,
                  nodes_found: metadata.stats?.nodesFound ?? null,
                  cost_usd: llmTotalUsd > 0 ? llmTotalUsd : null,
                  llm_cost_breakdown_json: null,
                  crawl_metadata_json: metadata,
                }}
              />
              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer font-medium text-foreground/80 hover:text-foreground">
                  Raw crawl_metadata_json
                </summary>
                <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap break-words rounded-md border border-border bg-muted/15 p-3 text-foreground/85 leading-relaxed">
                  {JSON.stringify(metadata, null, 2)}
                </pre>
              </details>
            </>
          ) : (
            <p className="text-[12px] text-muted-foreground">No metadata for this run.</p>
          )}
        </TabsContent>
        <TabsContent value="llm" className="flex-1 min-h-0 overflow-y-auto mt-0 pt-3 space-y-2 data-[state=inactive]:hidden">
          {calls.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No LLM calls recorded (e.g. empty crawl or no API key).</p>
          ) : (
            calls.map(c => <CrawlLlmCallCard key={c.seq} call={c} />)
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
