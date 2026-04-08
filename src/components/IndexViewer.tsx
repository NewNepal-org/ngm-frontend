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
    const maxPages = 100; // Safety limit

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

const NODE_NAMES = {
    'kanun-patrika': 'kanun',
    'ciaa-annual-reports': 'ciaa',
    'ciaa-press-releases': 'press',
} as const;

type TabKey = 'kanun' | 'ciaa' | 'press';

export default function IndexViewer() {
    const [stubs, setStubs] = useState<Record<TabKey, string | null>>({ kanun: null, ciaa: null, press: null });
    const [manuscripts, setManuscripts] = useState<Record<TabKey, Manuscript[] | null>>({ kanun: null, ciaa: null, press: null });
    const [tabLoading, setTabLoading] = useState<Record<TabKey, boolean>>({ kanun: false, ciaa: false, press: false });
    const [loadingProgress, setLoadingProgress] = useState<Record<TabKey, { current: number; total: number } | null>>({ kanun: null, ciaa: null, press: null });
    const [rootLoading, setRootLoading] = useState(true);
    const [rootError, setRootError] = useState<string | null>(null);
    const [tabErrors, setTabErrors] = useState<Record<TabKey, string | null>>({ kanun: null, ciaa: null, press: null });
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
                
                const refs: Record<TabKey, string | null> = { kanun: null, ciaa: null, press: null };
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
            const items = await fetchAllManuscripts(ref, controller.signal, (current, total) => {
                setLoadingProgress((prev) => ({ ...prev, [tab]: { current, total } }));
            });
            setManuscripts((prev) => ({ ...prev, [tab]: items }));
            setLoadingProgress((prev) => ({ ...prev, [tab]: null }));
        } catch (err: unknown) {
            if (err instanceof Error && (err.message === 'Request was cancelled' || err.name === 'AbortError')) {
                return; // Don't set error for cancelled requests
            }
            const msg = err instanceof Error ? err.message : 'Failed to load data';
            setTabErrors((prev) => ({ ...prev, [tab]: msg }));
            setLoadingProgress((prev) => ({ ...prev, [tab]: null }));
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

    if (rootLoading) {
        return (
            <div className="state-container bounce-in">
                <div className="spinner"></div>
                <p>Loading database...</p>
            </div>
        );
    }

    if (rootError) {
        return (
            <div className="state-container error fade-in">
                <p className="error-icon">⚠️</p>
                <h2>Connection Error</h2>
                <p>{rootError}</p>
                <button className="btn-primary" onClick={() => window.location.reload()}>Retry</button>
            </div>
        );
    }

    const renderLoading = (tab?: TabKey) => {
        const progress = tab ? loadingProgress[tab] : null;
        return (
            <div className="state-container bounce-in">
                <div className="spinner"></div>
                {progress ? (
                    <p>Loading page {progress.current}...</p>
                ) : (
                    <p>Loading...</p>
                )}
            </div>
        );
    };

    const renderKanunPatrika = () => {
        if (tabLoading.kanun) return renderLoading('kanun');
        if (tabErrors.kanun) {
            return (
                <div className="state-container error fade-in">
                    <p className="error-icon">⚠️</p>
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
                size: 60,
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
                size: 120,
                cell: (info) => {
                    const year = info.getValue() as string;
                    return year === 'N/A' ? year : `${year} BS`;
                },
            },
            {
                id: 'actions',
                header: 'Actions',
                size: 100,
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
                    pageSize={10}
                    searchPlaceholder="Search by document name, year, or any keyword..."
                    showAdvancedSearch={false}
                    onNameSearch={(rowText, nameQuery) => containsPersonName(rowText, nameQuery)}
                />
            </div>
        );
    };

    const renderCiaaReports = () => {
        if (tabLoading.ciaa) return renderLoading('ciaa');
        if (tabErrors.ciaa) {
            return (
                <div className="state-container error fade-in">
                    <p className="error-icon">⚠️</p>
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
                size: 100,
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
                size: 150,
            },
            {
                id: 'actions',
                header: 'Actions',
                size: 100,
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
                    pageSize={10}
                    searchPlaceholder="Search by serial number, title, date, or any keyword..."
                    showAdvancedSearch={false}
                    onNameSearch={(rowText, nameQuery) => containsPersonName(rowText, nameQuery)}
                />
            </div>
        );
    };

    const renderPressReleases = () => {
        if (tabLoading.press) return renderLoading('press');
        if (tabErrors.press) {
            return (
                <div className="state-container error fade-in">
                    <p className="error-icon">⚠️</p>
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
                size: 80,
                cell: (info) => info.getValue() || 'N/A',
            },
            {
                accessorKey: 'title',
                header: 'Title',
            },
            {
                accessorKey: 'date',
                header: 'Publication Date',
                size: 150,
            },
            {
                id: 'actions',
                header: 'Download',
                size: 200,
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
                    pageSize={10}
                    searchPlaceholder="Search by press release number, title, date, or any keyword..."
                    showAdvancedSearch={false}
                    onNameSearch={(rowText, nameQuery) => containsPersonName(rowText, nameQuery)}
                />
            </div>
        );
    };

    return (
        <div className="index-viewer">
            <div className="tabs slide-down">
                <button
                    className={`tab-btn ${activeTab === 'kanun' ? 'active' : ''}`}
                    onClick={() => setActiveTab('kanun')}
                >
                    Kanun Patrika
                </button>
                <button
                    className={`tab-btn ${activeTab === 'ciaa' ? 'active' : ''}`}
                    onClick={() => setActiveTab('ciaa')}
                >
                    CIAA Annual Reports
                </button>
                <button
                    className={`tab-btn ${activeTab === 'press' ? 'active' : ''}`}
                    onClick={() => setActiveTab('press')}
                >
                    CIAA Press Releases
                </button>
            </div>

            <div className="content-area">
                {activeTab === 'kanun' && renderKanunPatrika()}
                {activeTab === 'ciaa' && renderCiaaReports()}
                {activeTab === 'press' && renderPressReleases()}
            </div>
        </div>
    );
}