import { type ColumnDef, type RowData, createColumnHelper, createSortedRowModel, rowSortingFeature, sortFns, tableFeatures, useTable } from "@tanstack/react-table";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel(), sortFns });
export type Column<T extends RowData> = ColumnDef<typeof features, T, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const columns = <T extends RowData>() => createColumnHelper<typeof features, T>();

/** A dense, sortable table; rows carry data-testid from `rowTestId` (e2e and operators' bookmarks rely on them). */
export function DataTable<T extends RowData>({
  id,
  data,
  columns: cols,
  rowTestId,
  rowClassName,
  initialSort,
}: {
  id: string;
  data: T[];
  columns: Column<T>[];
  rowTestId?: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  initialSort?: { id: string; desc: boolean }[];
}) {
  const table = useTable({ key: id, features, columns: cols, data, initialState: { sorting: initialSort ?? [] } });
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <Table>
        <TableHeader className="bg-muted/50">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                const sortable = header.column.getCanSort();
                return (
                  <TableHead key={header.id} className="h-9 text-xs font-medium text-muted-foreground" aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}>
                    {header.isPlaceholder ? null : sortable ? (
                      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={header.column.getToggleSortingHandler()}>
                        <table.FlexRender header={header} />
                        {sorted === "asc" ? <ArrowUp className="size-3" aria-hidden /> : sorted === "desc" ? <ArrowDown className="size-3" aria-hidden /> : null}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} data-testid={rowTestId?.(row.original)} className={cn("text-sm", rowClassName?.(row.original))}>
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id} className="py-2 align-middle">
                  {/* Called, not mounted: the column definitions are rebuilt on every render (the panel ticks each
                      second), and as a component each cell would be a new type every time — its menus and inputs
                      would be torn down and rebuilt under the operator's hand. */}
                  {typeof cell.column.columnDef.cell === "function" ? cell.column.columnDef.cell(cell.getContext()) : <table.FlexRender cell={cell} />}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
