"use client";

/**
 * The Org console spend grid (BACKLOG P5-09), on AG Grid Community. The grid virtualises its
 * rows, so 12,000 Calls scroll smoothly.
 *
 * Row grouping is an AG Grid Enterprise feature, so "Group by" is done here instead: the
 * Calls are summed into one row per team, agent, vendor, listing or day, in bigint
 * micro-USD, and the grid shows those rows. The CSV export is the grid's own (Community)
 * and writes whatever view is showing, amounts as dollars with six decimals.
 */
import {
  AllCommunityModule,
  colorSchemeDark,
  colorSchemeLight,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type ProcessCellForExportParams,
  type ValueFormatterParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatUsd, toUsdDecimal } from "@/lib/money";

ModuleRegistry.registerModules([AllCommunityModule]);

/** One Call as the page sends it. Amounts are strings of integer micro-USD. */
export interface GridRow {
  callId: string;
  at: string;
  day: string;
  team: string;
  agent: string;
  vendor: string;
  listing: string;
  endpoint: string;
  status: "paid" | "free" | "refunded" | "blocked";
  priceMicro: string;
  spentMicro: string;
  simulated: boolean;
}

interface CallRow extends Omit<GridRow, "priceMicro" | "spentMicro"> {
  priceMicro: bigint;
  spentMicro: bigint;
}

interface GroupRow {
  group: string;
  calls: number;
  simulatedCalls: number;
  spentMicro: bigint;
  simulatedMicro: bigint;
}

type GroupBy = "none" | "team" | "agent" | "vendor" | "listing" | "day";

const GROUP_LABELS: Record<GroupBy, string> = {
  none: "No grouping (one row per Call)",
  team: "Team",
  agent: "Agent",
  vendor: "Vendor",
  listing: "Listing",
  day: "Day",
};

const MONEY_COLUMNS = new Set(["priceMicro", "spentMicro", "simulatedMicro"]);

function compareBigint(a: bigint | undefined, b: bigint | undefined): number {
  const x = a ?? 0n;
  const y = b ?? 0n;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Money columns: sorted and summed as bigint, shown with formatUsd. */
function moneyColumn<T>(field: keyof T & string, headerName: string): ColDef<T> {
  return {
    field: field as unknown as ColDef<T>["field"],
    colId: field,
    headerName,
    type: "rightAligned",
    cellClass: "tabular-nums",
    comparator: compareBigint,
    valueFormatter: (p: ValueFormatterParams<T, bigint>) =>
      typeof p.value === "bigint" ? formatUsd(p.value) : "",
    // Filtering compares dollars as numbers; it only picks rows and never feeds a total.
    filter: "agNumberColumnFilter",
    filterValueGetter: (p) => {
      const value = (p.data as Record<string, unknown> | undefined)?.[field];
      return typeof value === "bigint" ? Number(value) / 1_000_000 : null;
    },
    width: 130,
  };
}

function SimulatedCell({ value }: ICellRendererParams<CallRow, boolean>) {
  return value ? (
    <span className="rounded border border-line px-1.5 text-xs text-muted">simulated</span>
  ) : null;
}

const callColumns: ColDef<CallRow>[] = [
  {
    field: "at",
    headerName: "Time (UTC)",
    width: 180,
    sort: "desc",
    valueFormatter: (p) =>
      p.node?.rowPinned ? String(p.value) : String(p.value).replace("T", " ").slice(0, 19),
  },
  { field: "day", headerName: "Day", width: 120 },
  { field: "team", headerName: "Team", width: 130 },
  { field: "agent", headerName: "Agent", width: 170 },
  { field: "vendor", headerName: "Vendor", width: 150 },
  { field: "listing", headerName: "Listing", width: 170 },
  { field: "endpoint", headerName: "Endpoint", width: 190 },
  { field: "status", headerName: "Status", width: 110 },
  moneyColumn<CallRow>("priceMicro", "Price"),
  moneyColumn<CallRow>("spentMicro", "Spend"),
  {
    field: "simulated",
    headerName: "Simulated",
    width: 120,
    cellRenderer: SimulatedCell,
    filter: true,
  },
  { field: "callId", headerName: "Call id", width: 300, hide: true },
];

function groupColumns(groupBy: GroupBy): ColDef<GroupRow>[] {
  return [
    { field: "group", headerName: GROUP_LABELS[groupBy], width: 220, flex: 1 },
    {
      field: "calls",
      headerName: "Calls",
      type: "rightAligned",
      width: 110,
      filter: "agNumberColumnFilter",
    },
    moneyColumn<GroupRow>("spentMicro", "Spend"),
    {
      field: "simulatedCalls",
      headerName: "Simulated calls",
      type: "rightAligned",
      width: 150,
      filter: "agNumberColumnFilter",
    },
    moneyColumn<GroupRow>("simulatedMicro", "Of which simulated"),
  ];
}

function groupRows(rows: CallRow[], groupBy: Exclude<GroupBy, "none">): GroupRow[] {
  const groups = new Map<string, GroupRow>();
  for (const row of rows) {
    const key = row[groupBy];
    let group = groups.get(key);
    if (!group) {
      group = { group: key, calls: 0, simulatedCalls: 0, spentMicro: 0n, simulatedMicro: 0n };
      groups.set(key, group);
    }
    group.calls++;
    group.spentMicro += row.spentMicro;
    if (row.simulated) {
      group.simulatedCalls++;
      group.simulatedMicro += row.spentMicro;
    }
  }
  return [...groups.values()].sort((a, b) => compareBigint(b.spentMicro, a.spentMicro));
}

/** The pinned totals row over whatever passes the grid's filters. */
function totalsOf(api: GridApi, grouped: boolean): Record<string, unknown> {
  let calls = 0;
  let simulatedCalls = 0;
  let spentMicro = 0n;
  let simulatedMicro = 0n;
  api.forEachNodeAfterFilter((node) => {
    const data = node.data as (CallRow & GroupRow) | undefined;
    if (!data) return;
    if (grouped) {
      calls += data.calls;
      simulatedCalls += data.simulatedCalls;
      spentMicro += data.spentMicro;
      simulatedMicro += data.simulatedMicro;
    } else {
      calls++;
      spentMicro += data.spentMicro;
      if (data.simulated) {
        simulatedCalls++;
        simulatedMicro += data.spentMicro;
      }
    }
  });
  const label = `Total: ${calls.toLocaleString("en-US")} calls, ${simulatedCalls.toLocaleString("en-US")} simulated (${formatUsd(simulatedMicro)})`;
  return grouped
    ? { group: "Total", calls, simulatedCalls, spentMicro, simulatedMicro }
    : { at: label, spentMicro };
}

const subscribeDark = (onChange: () => void) => {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

export function SpendGrid({
  rows,
  range,
}: {
  rows: GridRow[];
  range: { from: string; to: string };
}) {
  const apiRef = useRef<GridApi | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [totals, setTotals] = useState<Record<string, unknown>[]>([]);
  const dark = useSyncExternalStore(
    subscribeDark,
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
  const theme = useMemo(
    () => themeQuartz.withPart(dark ? colorSchemeDark : colorSchemeLight),
    [dark],
  );

  const callRows = useMemo<CallRow[]>(
    () =>
      rows.map((row) => ({
        ...row,
        priceMicro: BigInt(row.priceMicro),
        spentMicro: BigInt(row.spentMicro),
      })),
    [rows],
  );
  const grouped = groupBy !== "none";
  const rowData = useMemo(
    () => (groupBy === "none" ? callRows : groupRows(callRows, groupBy)),
    [callRows, groupBy],
  );
  const columnDefs = useMemo(
    () => (groupBy === "none" ? callColumns : groupColumns(groupBy)) as ColDef[],
    [groupBy],
  );

  const refreshTotals = useCallback(() => {
    if (apiRef.current) setTotals([totalsOf(apiRef.current, grouped)]);
  }, [grouped]);

  const onGridReady = useCallback(
    (event: GridReadyEvent) => {
      apiRef.current = event.api;
      refreshTotals();
    },
    [refreshTotals],
  );

  const exportCsv = () => {
    apiRef.current?.exportDataAsCsv({
      fileName: `piko-spend-${grouped ? `by-${groupBy}-` : ""}${range.from}-to-${range.to}.csv`,
      allColumns: true,
      skipPinnedBottom: true,
      processHeaderCallback: ({ column }) => {
        const id = column.getColId();
        if (id === "simulated") return "simulated";
        const name = column.getColDef().headerName ?? id;
        return MONEY_COLUMNS.has(id) ? `${name} (USD)` : name;
      },
      processCellCallback: (p: ProcessCellForExportParams) => {
        const id = p.column.getColId();
        if (MONEY_COLUMNS.has(id)) return typeof p.value === "bigint" ? toUsdDecimal(p.value) : "";
        if (id === "simulated") return p.value ? "true" : "false";
        return p.value == null ? "" : String(p.value);
      },
    });
  };

  return (
    <section aria-label="Spend grid" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          Group by
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            className="rounded border border-line bg-background px-2 py-1"
          >
            {(Object.keys(GROUP_LABELS) as GroupBy[]).map((key) => (
              <option key={key} value={key}>
                {GROUP_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-3 text-sm text-muted">
          <span>
            {rows.length.toLocaleString("en-US")} calls. Simulated traffic is labelled
            &quot;simulated&quot;.
          </span>
          <button
            type="button"
            onClick={exportCsv}
            className="rounded border border-line px-3 py-1.5 font-medium text-foreground"
          >
            Download CSV
          </button>
        </div>
      </div>
      <div className="h-[640px] w-full">
        <AgGridReact
          theme={theme}
          rowData={rowData as (CallRow | GroupRow)[]}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          getRowId={(p) => (grouped ? String(p.data.group) : String(p.data.callId))}
          pinnedBottomRowData={totals}
          onGridReady={onGridReady}
          onFilterChanged={refreshTotals}
          onRowDataUpdated={refreshTotals}
          animateRows={false}
        />
      </div>
    </section>
  );
}
