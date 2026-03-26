import {
    useReactTable,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    flexRender,
    type ColumnDef,
    type SortingState,
    type ColumnFiltersState,
} from '@tanstack/react-table';
import { useState } from 'react';

interface DataTableProps<TData> {
    data: TData[];
    columns: ColumnDef<TData, any>[];
    pageSize?: number;
    searchPlaceholder?: string;
}

export function DataTable<TData>({ 
    data, 
    columns, 
    pageSize = 20,
    searchPlaceholder = "Search across all fields..."
}: DataTableProps<TData>) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
    const [globalFilter, setGlobalFilter] = useState('');

    const table = useReactTable({
        data,
        columns,
        state: {
            sorting,
            columnFilters,
            globalFilter,
        },
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        onGlobalFilterChange: setGlobalFilter,
        getCoreRowModel: getCoreRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        getSortedRowModel: getSortedRowModel(),
        initialState: {
            pagination: {
                pageSize: 10,
            },
        },
    });

    return (
        <div className="data-table-container">
            {/* Global Search */}
            <div className="table-controls">
                <div className="search-container">
                    <span className="search-icon">🔍</span>
                    <input
                        type="text"
                        value={globalFilter ?? ''}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                        placeholder={searchPlaceholder}
                        className="table-search"
                        title="Type any keyword to search across all columns (e.g., year, name, title)"
                    />
                    {globalFilter && (
                        <button
                            className="clear-search"
                            onClick={() => setGlobalFilter('')}
                            title="Clear search"
                        >
                            ✕
                        </button>
                    )}
                </div>
                <div className="table-info">
                    {table.getFilteredRowModel().rows.length !== data.length ? (
                        <>
                            <span className="filtered-count">{table.getFilteredRowModel().rows.length}</span> of {data.length} records
                        </>
                    ) : (
                        <>{data.length} records</>
                    )}
                </div>
            </div>

            {/* Table */}
            <div className="table-wrapper">
                <table className="data-table">
                    <thead>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <th key={header.id}>
                                        {header.isPlaceholder ? null : (
                                            <div
                                                className={
                                                    header.column.getCanSort()
                                                        ? 'sortable-header'
                                                        : ''
                                                }
                                                onClick={header.column.getToggleSortingHandler()}
                                            >
                                                {flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                                {{
                                                    asc: ' ↑',
                                                    desc: ' ↓',
                                                }[header.column.getIsSorted() as string] ?? null}
                                            </div>
                                        )}
                                        {/* Column filters hidden - only global search is active */}
                                    </th>
                                ))}
                            </tr>
                        ))}
                    </thead>
                    <tbody>
                        {table.getRowModel().rows.map((row) => (
                            <tr key={row.id}>
                                {row.getVisibleCells().map((cell) => (
                                    <td key={cell.id}>
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            <div className="table-pagination">
                <div className="pagination-controls">
                    <button
                        onClick={() => table.setPageIndex(0)}
                        disabled={!table.getCanPreviousPage()}
                        className="pagination-btn"
                    >
                        ⟪ First
                    </button>
                    <button
                        onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage()}
                        className="pagination-btn"
                    >
                        ← Previous
                    </button>
                    <span className="pagination-info">
                        Page {table.getState().pagination.pageIndex + 1} of{' '}
                        {table.getPageCount()}
                    </span>
                    <button
                        onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage()}
                        className="pagination-btn"
                    >
                        Next →
                    </button>
                    <button
                        onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                        disabled={!table.getCanNextPage()}
                        className="pagination-btn"
                    >
                        Last ⟫
                    </button>
                </div>
                <div className="page-size-selector">
                    <label>
                        Show:
                        <select
                            value={table.getState().pagination.pageSize}
                            onChange={(e) => table.setPageSize(Number(e.target.value))}
                            className="page-size-select"
                        >
                            {[10, 20, 30, 50, 100].map((size) => (
                                <option key={size} value={size}>
                                    {size}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
            </div>
        </div>
    );
}
