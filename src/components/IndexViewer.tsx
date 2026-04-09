import { useState, useEffect, useCallback, useRef } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from './DataTable';
// TODO: Replace with backend metadata extraction when persons data is available
import { containsPersonName } from '../data/casesData';

// TODO: Refactor this file into smaller components:
// - Extract API logic → src/api/indexApi.ts (fetchPage, Types)
// - Extract tab renderers → src/components/tabs/KanunTab.tsx, CiaaReportsTab.tsx, PressReleasesTab.tsx
// - Extract shared UI → src/components/ui/LoadingSpinner.tsx, ErrorMessage.tsx, EmptyState.tsx
// - Keep IndexViewer.tsx as orchestrator with state management only

// Configuration constants
const FETCH_CONFIG = {
    MAX_PAGES_SIMPLE: 100,
    MAX_PAGES_RECURSIVE: 5000,
    MAX_PAGES_PER_YEAR: 50,
    MAX_DEPTH: 3,
    BATCH_SIZE: 10,
} as const;

const TABLE_CONFIG = {
    DEFAULT_PAGE_SIZE: 10,
    COLUMN_SIZE_SMALL: 60,
    COLUMN_SIZE_MEDIUM: 80,
    COLUMN_SIZE_LARGE: 100,
    COLUMN_SIZE_XLARGE: 120,
    COLUMN_SIZE_XXLARGE: 150,
    COLUMN_SIZE_XXXLARGE: 200,
} as const;

// NGM Index v2.0 types - Tree-based hierarchical index
type Manuscript = {
    url: string;
    file_name: string;
    metadata: Record<string, unknown>;
};

type IndexNodeStub = {
    name: string;
    path: string;
    $ref: string;
};

type IndexNodeFull = {
    name: string;
    path: string;
    manuscripts?: Manuscript[];
    children?: IndexNodeStub[];
    next?: string; // Pagination link
};

type RootIndex = {
    name: 'root';
    path: '/';
    children: IndexNodeStub[];
};

// Convert Devanagari numerals to ASCII
function devanagariToAscii(text: string): string {
    const devanagariDigits = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
    let result = text;
    devanagariDigits.forEach((devDigit, index) => {
        result = result.replace(new RegExp(devDigit, 'g'), index.toString());
    });
    return result;
}

// Extract years from filenames - years are in Devanagari numerals (२०६५, २०६६, etc.)
function extractYear(filename: string): string | null {
    // Match Devanagari numerals (०-९) for 4-digit year
    const match = filename.match(/[०-९]{4}/);
    if (!match) return null;
    // Convert Devanagari to ASCII
    return devanagariToAscii(match[0]);
}

// Convert production URLs to use proxy in development
const isDevelopment = import.meta.env.DEV;

function getProxiedUrl(url: string): string {
    if (isDevelopment && url.startsWith('https://ngm-store.jawafdehi.org')) {
        return url.replace('https://ngm-store.jawafdehi.org', '/api');
    }
    return url;
}

/** Fetch all manuscripts for a node, following pagination via `next` links. */
async function fetchAllManuscripts(
    ref: string, 
    signal?: AbortSignal,
    onProgress?: (current: number, total: number) => void
): Promise<Manuscript[]> {
    const manuscripts: Manuscript[] = [];
    let url: string | undefined = ref;
    const visitedUrls = new Set<string>();
    let pageCount = 0;
    const maxPages = FETCH_CONFIG.MAX_PAGES_SIMPLE;

    while (url) {
        if (signal?.aborted) {
            throw new Error('Request was cancelled');
        }

        if (visitedUrls.has(url)) {
            throw new Error(`Circular reference detected: ${url}`);
        }

        if (pageCount >= maxPages) {
            throw new Error(`Maximum page limit (${maxPages}) exceeded`);
        }

        visitedUrls.add(url);
        pageCount++;

        // Report progress
        if (onProgress) {
            onProgress(pageCount, maxPages);
        }

        const proxiedUrl = getProxiedUrl(url);
        const res = await fetch(proxiedUrl, { signal });
        if (!res.ok) throw new Error(`Failed to fetch ${url}`);
        const node: IndexNodeFull = await res.json();
        if (node.manuscripts) manuscripts.push(...node.manuscripts);
        url = node.next;
    }

    return manuscripts;
}

/** Fetch manuscripts recursively with depth limit for instant display. */
async function fetchAllManuscriptsRecursive(
    ref: string,
    signal?: AbortSignal,
    onProgress?: (current: number, total: number) => void,
    onDataChunk?: (manuscripts: Manuscript[]) => void,
    maxDepth: number = FETCH_CONFIG.MAX_DEPTH,
    maxPagesPerYear: number = FETCH_CONFIG.MAX_PAGES_PER_YEAR
): Promise<Manuscript[]> {
    const visitedUrls = new Set<string>();
    let pageCount = 0;
    const maxPages = FETCH_CONFIG.MAX_PAGES_RECURSIVE;
    const allManuscripts: Manuscript[] = [];
    const yearPageCounts = new Map<string, number>();

    async function traverse(url: string, depth: number = 0, branchContext: string = '', yearContext: string = ''): Promise<Manuscript[]> {
        if (signal?.aborted) {
            throw new Error('Request was cancelled');
        }

        if (visitedUrls.has(url)) {
            return [];
        }

        if (pageCount >= maxPages) {
            console.warn(`Reached maximum page limit (${maxPages}), stopping fetch`);
            return [];
        }

        // Check per-branch-year limit
        if (branchContext && yearContext && depth >= 2) {
            const branchYearKey = `${branchContext}|${yearContext}`;
            const yearPages = yearPageCounts.get(branchYearKey) || 0;
            if (yearPages >= maxPagesPerYear) {
                console.warn(`Reached page limit for ${branchContext}/${yearContext} (${maxPagesPerYear} pages), skipping`);
                return [];
            }
        }

        visitedUrls.add(url);
        pageCount++;
        
        if (branchContext && yearContext && depth >= 2) {
            const branchYearKey = `${branchContext}|${yearContext}`;
            yearPageCounts.set(branchYearKey, (yearPageCounts.get(branchYearKey) || 0) + 1);
        }

        if (onProgress) {
            onProgress(pageCount, maxPages);
        }

        const proxiedUrl = getProxiedUrl(url);
        const res = await fetch(proxiedUrl, { signal });
        if (!res.ok) throw new Error(`Failed to fetch ${url}`);
        const node: IndexNodeFull = await res.json();

        const localManuscripts: Manuscript[] = [];

        // Add manuscripts from this node
        if (node.manuscripts) {
            localManuscripts.push(...node.manuscripts);
            allManuscripts.push(...node.manuscripts);
            
            // Send data chunk immediately for progressive rendering
            if (onDataChunk && node.manuscripts.length > 0) {
                onDataChunk([...allManuscripts]);
            }
        }

        // Only traverse children if within depth limit
        if (node.children && depth < maxDepth) {
            // Fetch all children (no filtering by year)
            const childrenToFetch = node.children;

            const batchSize = FETCH_CONFIG.BATCH_SIZE;
            for (let i = 0; i < childrenToFetch.length; i += batchSize) {
                const batch = childrenToFetch.slice(i, i + batchSize);
                const childResults = await Promise.all(
                    batch.map(child => {
                        // Pass branch and year context for tracking
                        const newBranchContext = depth === 0 ? child.name : branchContext;
                        const newYearContext = depth === 1 ? child.name : yearContext;
                        return traverse(child.$ref, depth + 1, newBranchContext, newYearContext);
                    })
                );
                childResults.forEach(result => {
                    localManuscripts.push(...result);
                });
            }
        }

        // Follow pagination (only at leaf level - case folders)
        if (node.next && depth >= maxDepth) {
            const nextResults = await traverse(node.next, depth, branchContext, yearContext);
            localManuscripts.push(...nextResults);
        }

        return localManuscripts;
    }

    await traverse(ref);
    return allManuscripts;
}

const NODE_NAMES = {
    'kanun-patrika': 'kanun',
    'ciaa-annual-reports': 'ciaa',
    'ciaa-press-releases': 'press',
    'court-orders': 'court',
} as const;

type TabKey = 'kanun' | 'ciaa' | 'press' | 'court';

export default function IndexViewer() {
    const [stubs, setStubs] = useState<Record<TabKey, string | null>>({ kanun: null, ciaa: null, press: null, court: null });
    const [manuscripts, setManuscripts] = useState<Record<TabKey, Manuscript[] | null>>({ kanun: null, ciaa: null, press: null, court: null });
    const [tabLoading, setTabLoading] = useState<Record<TabKey, boolean>>({ kanun: false, ciaa: false, press: false, court: false });
    const [loadingProgress, setLoadingProgress] = useState<Record<TabKey, { current: number; total: number } | null>>({ kanun: null, ciaa: null, press: null, court: null });
    const [isStreamingData, setIsStreamingData] = useState<Record<TabKey, boolean>>({ kanun: false, ciaa: false, press: false, court: false });
    const [rootLoading, setRootLoading] = useState(true);
    const [rootError, setRootError] = useState<string | null>(null);
    const [tabErrors, setTabErrors] = useState<Record<TabKey, string | null>>({ kanun: null, ciaa: null, press: null, court: null });
    const [activeTab, setActiveTab] = useState<TabKey>('kanun');
    const loadingRef = useRef<Set<TabKey>>(new Set());
    const abortControllersRef = useRef<Map<TabKey, AbortController>>(new Map());

    // Load root index once
    useEffect(() => {
        const controller = new AbortController();
        
        // Use Vite proxy for development, direct URL for production
        const indexUrl = isDevelopment 
            ? '/api/index-v2.json'
            : 'https://ngm-store.jawafdehi.org/index-v2.json';
            
        fetch(indexUrl, { signal: controller.signal })
            .then((res) => {
                if (!res.ok) throw new Error('Failed to fetch the NGM Index v2');
                return res.json() as Promise<RootIndex>;
            })
            .then((root) => {
                if (controller.signal.aborted) return;
                
                const refs: Record<TabKey, string | null> = { kanun: null, ciaa: null, press: null, court: null };
                for (const child of root.children) {
                    const tab = NODE_NAMES[child.name as keyof typeof NODE_NAMES];
                    if (tab) {
                        // Convert URLs to use proxy in development
                        refs[tab] = getProxiedUrl(child.$ref);
                    }
                }
                setStubs(refs);
                setRootLoading(false);
            })
            .catch((err) => {
                if (controller.signal.aborted || err.name === 'AbortError') return;
                
                setRootError(err.message || 'An unknown error occurred.');
                setRootLoading(false);
            });

        return () => controller.abort();
    }, []);

    // Lazy-load manuscripts when a tab is first activated
    const loadTab = useCallback(async (tab: TabKey) => {
        const ref = stubs[tab];
        if (!ref || manuscripts[tab] !== null || loadingRef.current.has(tab)) return;

        // Abort any existing request for this tab
        const existingController = abortControllersRef.current.get(tab);
        if (existingController) {
            existingController.abort();
        }

        // Clear any stale errors and progress before starting new load
        setTabErrors((prev) => ({ ...prev, [tab]: null }));
        setLoadingProgress((prev) => ({ ...prev, [tab]: null }));
        
        loadingRef.current.add(tab);
        setTabLoading((prev) => ({ ...prev, [tab]: true }));
        
        const controller = new AbortController();
        abortControllersRef.current.set(tab, controller);
        
        try {
            // Use recursive fetcher for court orders (has nested structure)
            // Use regular fetcher for other tabs (flat structure with pagination)
            if (tab === 'court') {
                // Enable streaming mode for court orders
                setIsStreamingData((prev) => ({ ...prev, [tab]: true }));
                
                const items = await fetchAllManuscriptsRecursive(
                    ref, 
                    controller.signal, 
                    (current, total) => {
                        setLoadingProgress((prev) => ({ ...prev, [tab]: { current, total } }));
                    },
                    (dataChunk) => {
                        // Progressive update: show data as it arrives
                        setManuscripts((prev) => ({ ...prev, [tab]: dataChunk }));
                    }
                );
                setManuscripts((prev) => ({ ...prev, [tab]: items }));
                setIsStreamingData((prev) => ({ ...prev, [tab]: false }));
            } else {
                const items = await fetchAllManuscripts(ref, controller.signal, (current, total) => {
                    setLoadingProgress((prev) => ({ ...prev, [tab]: { current, total } }));
                });
                setManuscripts((prev) => ({ ...prev, [tab]: items }));
            }
            setLoadingProgress((prev) => ({ ...prev, [tab]: null }));
        } catch (err: unknown) {
            if (err instanceof Error && (err.message === 'Request was cancelled' || err.name === 'AbortError')) {
                return; // Don't set error for cancelled requests
            }
            const msg = err instanceof Error ? err.message : 'Failed to load data';
            setTabErrors((prev) => ({ ...prev, [tab]: msg }));
            setLoadingProgress((prev) => ({ ...prev, [tab]: null }));
            setIsStreamingData((prev) => ({ ...prev, [tab]: false }));
        } finally {
            abortControllersRef.current.delete(tab);
            loadingRef.current.delete(tab);
            setTabLoading((prev) => ({ ...prev, [tab]: false }));
        }
    }, [stubs, manuscripts]);

    useEffect(() => {
        if (!rootLoading) {
            loadTab(activeTab);
        }
    }, [activeTab, rootLoading, loadTab]);

    // Cleanup on unmount - abort all pending requests
    useEffect(() => {
        const controllers = abortControllersRef.current;
        return () => {
            controllers.forEach((controller) => controller.abort());
            controllers.clear();
        };
    }, []);

    // All render functions must be declared before any early returns
    const renderLoading = useCallback((tab?: TabKey) => {
        const progress = tab ? loadingProgress[tab] : null;
        const streaming = tab ? isStreamingData[tab] : false;
        return (
            <div className="state-container bounce-in" role="status" aria-live="polite">
                <div className="spinner" aria-hidden="true"></div>
                {progress ? (
                    <p>Loading page {progress.current}... {streaming && '(showing results as they arrive)'}</p>
                ) : (
                    <p>Loading...</p>
                )}
            </div>
        );
    }, [loadingProgress, isStreamingData]);

    const renderKanunPatrika = useCallback(() => {
        if (tabLoading.kanun) return renderLoading('kanun');
        if (tabErrors.kanun) {
            return (
                <div className="state-container error fade-in" role="alert">
                    <p className="error-icon" aria-hidden="true">⚠️</p>
                    <p>{tabErrors.kanun}</p>
                    <button className="btn-primary" onClick={() => {
                        setTabErrors(prev => ({ ...prev, kanun: null }));
                        loadTab('kanun');
                    }}>Retry</button>
                </div>
            );
        }
        const allItems = manuscripts.kanun || [];
        if (allItems.length === 0) return <p className="empty-state">No records found for Kanun Patrika.</p>;

        // Transform data for table
        const tableData = allItems.map((item, index) => ({
            id: index + 1,
            fileName: item.file_name.replace('.pdf', ''),
            year: extractYear(item.file_name) || 'N/A',
            url: item.url,
        }));

        // Define columns
        const columns: ColumnDef<typeof tableData[0]>[] = [
            {
                accessorKey: 'id',
                header: '#',
                size: TABLE_CONFIG.COLUMN_SIZE_SMALL,
                enableColumnFilter: false,
            },
            {
                accessorKey: 'fileName',
                header: 'Document Name',
                cell: (info) => (
                    <a href={info.row.original.url} target="_blank" rel="noopener noreferrer">
                        {info.getValue() as string}
                    </a>
                ),
            },
            {
                accessorKey: 'year',
                header: 'Year (BS)',
                size: TABLE_CONFIG.COLUMN_SIZE_XLARGE,
                cell: (info) => {
                    const year = info.getValue() as string;
                    return year === 'N/A' ? year : `${year} BS`;
                },
            },
            {
                id: 'actions',
                header: 'Actions',
                size: TABLE_CONFIG.COLUMN_SIZE_LARGE,
                enableColumnFilter: false,
                enableSorting: false,
                cell: (info) => (
                    <a 
                        href={info.row.original.url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="badge"
                        style={{ textDecoration: 'none' }}
                    >
                        View PDF
                    </a>
                ),
            },
        ];

        return (
            <div className="fade-in">
                <DataTable 
                    data={tableData} 
                    columns={columns} 
                    pageSize={TABLE_CONFIG.DEFAULT_PAGE_SIZE}
                    searchPlaceholder="Search by document name, year, or any keyword..."
                    showAdvancedSearch={false}
                    onNameSearch={(rowText, nameQuery) => containsPersonName(rowText, nameQuery)}
                />
            </div>
        );
    }, [tabLoading.kanun, tabErrors.kanun, manuscripts.kanun, loadTab]);

    const renderCiaaReports = useCallback(() => {
        if (tabLoading.ciaa) return renderLoading('ciaa');
        if (tabErrors.ciaa) {
            return (
                <div className="state-container error fade-in" role="alert">
                    <p className="error-icon" aria-hidden="true">⚠️</p>
                    <p>{tabErrors.ciaa}</p>
                    <button className="btn-primary" onClick={() => {
                        setTabErrors(prev => ({ ...prev, ciaa: null }));
                        loadTab('ciaa');
                    }}>Retry</button>
                </div>
            );
        }
        const items = manuscripts.ciaa || [];
        if (items.length === 0) return <p className="empty-state">No records found for CIAA Annual Reports.</p>;

        // Transform and sort data for table
        const tableData = [...items]
            .sort((a, b) => {
                const rawDateA = a.metadata?.date ?? a.metadata?.year ?? null;
                const rawDateB = b.metadata?.date ?? b.metadata?.year ?? null;
                
                if (rawDateA && rawDateB) {
                    const dateA = new Date(String(rawDateA));
                    const dateB = new Date(String(rawDateB));
                    
                    if (!isNaN(dateA.getTime()) && !isNaN(dateB.getTime())) {
                        return dateB.getTime() - dateA.getTime();
                    }
                    
                    return String(rawDateB).localeCompare(String(rawDateA));
                }
                
                if (rawDateA && !rawDateB) return -1;
                if (!rawDateA && rawDateB) return 1;
                
                return b.file_name.localeCompare(a.file_name);
            })
            .map((item, index) => {
                const meta = item.metadata as Record<string, string>;
                return {
                    id: index + 1,
                    serialNumber: meta?.serial_number || 'N/A',
                    title: meta?.title || item.file_name,
                    date: meta?.date || 'Unknown Date',
                    url: item.url,
                };
            });

        // Define columns
        const columns: ColumnDef<typeof tableData[0]>[] = [
            {
                accessorKey: 'serialNumber',
                header: 'Serial No.',
                size: TABLE_CONFIG.COLUMN_SIZE_LARGE,
            },
            {
                accessorKey: 'title',
                header: 'Report Title',
                cell: (info) => (
                    <a href={info.row.original.url} target="_blank" rel="noopener noreferrer">
                        {info.getValue() as string}
                    </a>
                ),
            },
            {
                accessorKey: 'date',
                header: 'Date',
                size: TABLE_CONFIG.COLUMN_SIZE_XXLARGE,
            },
            {
                id: 'actions',
                header: 'Actions',
                size: TABLE_CONFIG.COLUMN_SIZE_LARGE,
                enableColumnFilter: false,
                enableSorting: false,
                cell: (info) => (
                    <a 
                        href={info.row.original.url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="badge warning"
                        style={{ textDecoration: 'none' }}
                    >
                        View PDF
                    </a>
                ),
            },
        ];

        return (
            <div className="fade-in">
                <DataTable 
                    data={tableData} 
                    columns={columns} 
                    pageSize={TABLE_CONFIG.DEFAULT_PAGE_SIZE}
                    searchPlaceholder="Search by serial number, title, date, or any keyword..."
                    showAdvancedSearch={false}
                    onNameSearch={(rowText, nameQuery) => containsPersonName(rowText, nameQuery)}
                />
            </div>
        );
    }, [tabLoading.ciaa, tabErrors.ciaa, manuscripts.ciaa, loadTab]);

    const renderPressReleases = useCallback(() => {
        if (tabLoading.press) return renderLoading('press');
        if (tabErrors.press) {
            return (
                <div className="state-container error fade-in" role="alert">
                    <p className="error-icon" aria-hidden="true">⚠️</p>
                    <p>{tabErrors.press}</p>
                    <button className="btn-primary" onClick={() => {
                        setTabErrors(prev => ({ ...prev, press: null }));
                        loadTab('press');
                    }}>Retry</button>
                </div>
            );
        }
        const items = manuscripts.press || [];
        if (items.length === 0) return <p className="empty-state">No records found for CIAA Press Releases.</p>;

        // Group manuscripts by press_id
        const grouped = new Map<string, { pressId: number | null; meta: Record<string, unknown>; files: Manuscript[] }>();
        for (const item of items) {
            const parsed = Number(item.metadata?.press_id);
            const hasValidPressId = Number.isFinite(parsed) && parsed > 0;
            const groupKey = hasValidPressId ? `press:${parsed}` : `file:${item.url}`;
            if (!grouped.has(groupKey)) {
                grouped.set(groupKey, {
                    pressId: hasValidPressId ? parsed : null,
                    meta: item.metadata,
                    files: [],
                });
            }
            grouped.get(groupKey)!.files.push(item);
        }

        // Transform data for table
        const tableData = [...grouped.entries()]
            .sort(([, a], [, b]) => (b.pressId ?? -Infinity) - (a.pressId ?? -Infinity))
            .map(([, { pressId, meta, files }]) => ({
                pressId: pressId ?? 0,
                title: String(meta?.title || `Press Release ${pressId ? `#${pressId}` : '(Unknown)'}`),
                date: String(meta?.publication_date || 'N/A'),
                fileCount: files.length,
                files: files,
            }));

        // Define columns
        const columns: ColumnDef<typeof tableData[0]>[] = [
            {
                accessorKey: 'pressId',
                header: 'No.',
                size: TABLE_CONFIG.COLUMN_SIZE_MEDIUM,
                cell: (info) => info.getValue() || 'N/A',
            },
            {
                accessorKey: 'title',
                header: 'Title',
            },
            {
                accessorKey: 'date',
                header: 'Publication Date',
                size: TABLE_CONFIG.COLUMN_SIZE_XXLARGE,
            },
            {
                id: 'actions',
                header: 'Download',
                size: TABLE_CONFIG.COLUMN_SIZE_XXXLARGE,
                enableColumnFilter: false,
                enableSorting: false,
                cell: (info) => (
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {info.row.original.files.map((file, i) => {
                            const ext = file.file_name.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toUpperCase() || 'FILE';
                            return (
                                <a
                                    key={file.url}
                                    href={file.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={`file-chip ${ext === 'PDF' ? 'pdf' : ext === 'DOC' || ext === 'DOCX' ? 'doc' : 'default'}`}
                                    style={{ fontSize: '0.7rem', padding: '3px 8px' }}
                                >
                                    {ext} {i + 1}
                                </a>
                            );
                        })}
                    </div>
                ),
            },
        ];

        return (
            <div className="fade-in">
                <DataTable 
                    data={tableData} 
                    columns={columns} 
                    pageSize={TABLE_CONFIG.DEFAULT_PAGE_SIZE}
                    searchPlaceholder="Search by press release number, title, date, or any keyword..."
                    showAdvancedSearch={false}
                    onNameSearch={(rowText, nameQuery) => containsPersonName(rowText, nameQuery)}
                />
            </div>
        );
    }, [tabLoading.press, tabErrors.press, manuscripts.press, loadTab]);

    const renderCourtOrders = useCallback(() => {
        const items = manuscripts.court || [];
        const isLoading = tabLoading.court;
        const isStreaming = isStreamingData.court;
        
        if (tabErrors.court) {
            return (
                <div className="state-container error fade-in" role="alert">
                    <p className="error-icon" aria-hidden="true">⚠️</p>
                    <p>{tabErrors.court}</p>
                    <button className="btn-primary" onClick={() => {
                        setTabErrors(prev => ({ ...prev, court: null }));
                        loadTab('court');
                    }}>Retry</button>
                </div>
            );
        }
        
        // Show loading only if no data yet
        if (isLoading && items.length === 0) {
            return renderLoading('court');
        }
        
        if (!isLoading && items.length === 0) {
            return <p className="empty-state">No records found for Court Orders.</p>;
        }

        // Transform data for table
        const tableData = items.map((item, index) => {
            // Extract case number from filename (e.g., "080-CR-0001.1.doc" -> "080-CR-0001")
            const caseMatch = item.file_name.match(/^(\d{3}-[A-Z]+-\d{4})/);
            const caseNumber = caseMatch ? caseMatch[1] : item.file_name;
            
            // Extract year from case number (e.g., "080-CR-0001" -> "080")
            const yearMatch = caseNumber.match(/^(\d{3})/);
            const year = yearMatch ? yearMatch[1] : 'N/A';
            
            // Extract document number (e.g., "080-CR-0001.1.doc" -> "1")
            const docMatch = item.file_name.match(/\.(\d+)\./);
            const docNumber = docMatch ? docMatch[1] : '1';
            
            return {
                id: index + 1,
                caseNumber,
                year,
                docNumber,
                fileName: item.file_name,
                url: item.url,
            };
        });

        // Define columns
        const columns: ColumnDef<typeof tableData[0]>[] = [
            {
                accessorKey: 'id',
                header: '#',
                size: TABLE_CONFIG.COLUMN_SIZE_SMALL,
                enableColumnFilter: false,
            },
            {
                accessorKey: 'caseNumber',
                header: 'Case Number',
                size: TABLE_CONFIG.COLUMN_SIZE_XXLARGE,
                cell: (info) => (
                    <a href={info.row.original.url} target="_blank" rel="noopener noreferrer">
                        {info.getValue() as string}
                    </a>
                ),
            },
            {
                accessorKey: 'year',
                header: 'Year (BS)',
                size: TABLE_CONFIG.COLUMN_SIZE_LARGE,
                cell: (info) => {
                    const year = info.getValue() as string;
                    return year === 'N/A' ? year : `20${year}`;
                },
            },
            {
                accessorKey: 'docNumber',
                header: 'Doc #',
                size: TABLE_CONFIG.COLUMN_SIZE_MEDIUM,
            },
            {
                accessorKey: 'fileName',
                header: 'File Name',
            },
            {
                id: 'actions',
                header: 'Actions',
                size: TABLE_CONFIG.COLUMN_SIZE_LARGE,
                enableColumnFilter: false,
                enableSorting: false,
                cell: (info) => {
                    const ext = info.row.original.fileName.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toUpperCase() || 'FILE';
                    return (
                        <a 
                            href={info.row.original.url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className={`file-chip ${ext === 'PDF' ? 'pdf' : ext === 'DOC' || ext === 'DOCX' ? 'doc' : 'default'}`}
                            style={{ textDecoration: 'none' }}
                        >
                            View {ext}
                        </a>
                    );
                },
            },
        ];

        return (
            <div className="fade-in">
                {isStreaming && (
                    <div style={{ padding: '0.5rem 1rem', background: '#dbeafe', borderRadius: '8px', marginBottom: '1rem', textAlign: 'center' }}>
                        <span style={{ color: '#1e40af', fontWeight: 600 }}>
                            ⏳ Loading more data... ({items.length} records loaded so far)
                        </span>
                    </div>
                )}
                <DataTable 
                    data={tableData} 
                    columns={columns} 
                    pageSize={TABLE_CONFIG.DEFAULT_PAGE_SIZE}
                    searchPlaceholder="Search by case number, year, or any keyword..."
                    showAdvancedSearch={false}
                    onNameSearch={(rowText, nameQuery) => containsPersonName(rowText, nameQuery)}
                />
            </div>
        );
    }, [tabLoading.court, tabErrors.court, manuscripts.court, isStreamingData.court, loadTab]);

    // Early returns after all hooks are declared
    if (rootLoading) {
        return (
            <div className="state-container bounce-in" role="status" aria-live="polite">
                <div className="spinner" aria-hidden="true"></div>
                <p>Loading database...</p>
            </div>
        );
    }

    if (rootError) {
        return (
            <div className="state-container error fade-in" role="alert">
                <p className="error-icon" aria-hidden="true">⚠️</p>
                <h2>Connection Error</h2>
                <p>{rootError}</p>
                <button className="btn-primary" onClick={() => window.location.reload()}>Retry</button>
            </div>
        );
    }

    return (
        <div className="index-viewer">
            <div className="tabs slide-down" role="tablist" aria-label="Document categories">
                <button
                    role="tab"
                    aria-selected={activeTab === 'kanun'}
                    aria-controls="kanun-panel"
                    className={`tab-btn ${activeTab === 'kanun' ? 'active' : ''}`}
                    onClick={() => setActiveTab('kanun')}
                >
                    Kanun Patrika
                </button>
                <button
                    role="tab"
                    aria-selected={activeTab === 'ciaa'}
                    aria-controls="ciaa-panel"
                    className={`tab-btn ${activeTab === 'ciaa' ? 'active' : ''}`}
                    onClick={() => setActiveTab('ciaa')}
                >
                    CIAA Annual Reports
                </button>
                <button
                    role="tab"
                    aria-selected={activeTab === 'press'}
                    aria-controls="press-panel"
                    className={`tab-btn ${activeTab === 'press' ? 'active' : ''}`}
                    onClick={() => setActiveTab('press')}
                >
                    CIAA Press Releases
                </button>
                <button
                    role="tab"
                    aria-selected={activeTab === 'court'}
                    aria-controls="court-panel"
                    className={`tab-btn ${activeTab === 'court' ? 'active' : ''}`}
                    onClick={() => setActiveTab('court')}
                >
                    Court Orders
                </button>
            </div>

            <div className="content-area">
                <div id="kanun-panel" role="tabpanel" aria-labelledby="kanun-tab" hidden={activeTab !== 'kanun'}>
                    {activeTab === 'kanun' && renderKanunPatrika()}
                </div>
                <div id="ciaa-panel" role="tabpanel" aria-labelledby="ciaa-tab" hidden={activeTab !== 'ciaa'}>
                    {activeTab === 'ciaa' && renderCiaaReports()}
                </div>
                <div id="press-panel" role="tabpanel" aria-labelledby="press-tab" hidden={activeTab !== 'press'}>
                    {activeTab === 'press' && renderPressReleases()}
                </div>
                <div id="court-panel" role="tabpanel" aria-labelledby="court-tab" hidden={activeTab !== 'court'}>
                    {activeTab === 'court' && renderCourtOrders()}
                </div>
            </div>
        </div>
    );
}