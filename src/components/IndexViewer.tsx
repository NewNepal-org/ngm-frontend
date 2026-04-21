import { useState, useEffect, useCallback, useRef } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from './DataTable';
import CIAADatasetViewer from './CIAADatasetViewer';
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
    MAX_PAGES_RECURSIVE: 10_000, // Large finite ceiling to prevent unbounded memory growth
    MAX_PAGES_PER_YEAR: 10_000, // Large finite ceiling for per-year fetches
    MAX_DEPTH: 10, // Deep enough for any reasonable structure
    BATCH_SIZE: 20, // Increased for faster parallel fetching
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
            const currentCount = (yearPageCounts.get(branchYearKey) || 0) + 1;
            yearPageCounts.set(branchYearKey, currentCount);
            
            // Log progress for each year (every 50 pages for large datasets)
            if (currentCount % 50 === 0) {
                console.log(`📄 ${branchContext}/${yearContext}: ${currentCount} pages loaded, ${allManuscripts.length.toLocaleString()} total items`);
            }
        }
        
        // Log overall progress every 100 pages
        if (pageCount % 100 === 0) {
            console.log(`⏳ Progress: ${pageCount} pages fetched, ${allManuscripts.length.toLocaleString()} items loaded`);
        }

        if (onProgress) {
            onProgress(pageCount, maxPages);
        }

        const proxiedUrl = getProxiedUrl(url);
        const res = await fetch(proxiedUrl, { signal });
        if (!res.ok) throw new Error(`Failed to fetch ${url}`);
        const node: IndexNodeFull = await res.json();

        const localManuscripts: Manuscript[] = [];
        
        // Debug logging
        if (depth <= 2) {
            console.log(`🔍 Depth ${depth}: ${node.name || 'unnamed'}, children: ${node.children?.length || 0}, manuscripts: ${node.manuscripts?.length || 0}, has next: ${!!node.next}`);
        }

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

        // Follow pagination at ALL depths where it exists
        // This ensures we get all pages at year level, case folder level, etc.
        if (node.next) {
            const nextResults = await traverse(node.next, depth, branchContext, yearContext);
            localManuscripts.push(...nextResults);
        }

        return localManuscripts;
    }

    await traverse(ref);
    
    // Log final summary
    console.log(`✅ Fetch complete: ${allManuscripts.length.toLocaleString()} total items, ${pageCount.toLocaleString()} pages fetched`);
    console.log(`📊 Per-year breakdown:`, Array.from(yearPageCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `${key}: ${count} pages`)
    );
    
    return allManuscripts;
}

const NODE_NAMES = {
    'kanun-patrika': 'kanun',
    'ciaa-annual-reports': 'ciaa',
    'ciaa-press-releases': 'press',
    'court-orders': 'court',
} as const;

type TabKey = 'kanun' | 'ciaa' | 'press' | 'court' | 'dataset';

export default function IndexViewer() {
    const [stubs, setStubs] = useState<Record<TabKey, string | null>>({ kanun: null, ciaa: null, press: null, court: null, dataset: null });
    const [manuscripts, setManuscripts] = useState<Record<TabKey, Manuscript[] | null>>({ kanun: null, ciaa: null, press: null, court: [], dataset: null });
    const [tabLoading, setTabLoading] = useState<Record<TabKey, boolean>>({ kanun: false, ciaa: false, press: false, court: false, dataset: false });
    const [loadingProgress, setLoadingProgress] = useState<Record<TabKey, { current: number; total: number } | null>>({ kanun: null, ciaa: null, press: null, court: null, dataset: null });
    const [isStreamingData, setIsStreamingData] = useState<Record<TabKey, boolean>>({ kanun: false, ciaa: false, press: false, court: false, dataset: false });
    const [rootLoading, setRootLoading] = useState(true);
    const [rootError, setRootError] = useState<string | null>(null);
    const [tabErrors, setTabErrors] = useState<Record<TabKey, string | null>>({ kanun: null, ciaa: null, press: null, court: null, dataset: null });
    const [activeTab, setActiveTab] = useState<TabKey>('kanun');
    const [hasVisitedDataset, setHasVisitedDataset] = useState(false);
    const loadingRef = useRef<Set<TabKey>>(new Set());
    const abortControllersRef = useRef<Map<TabKey, AbortController>>(new Map());
    const hasAttemptedLoadRef = useRef<Set<TabKey>>(new Set());

    // Court filter state
    const [courtFilters, setCourtFilters] = useState<{
        selectedCourt: string | null;
        startYear: string;
        endYear: string;
    }>({
        selectedCourt: null,
        startYear: '',
        endYear: '',
    });
    const [availableCourts, setAvailableCourts] = useState<{ name: string; ref: string }[]>([]);
    const [loadingCourts, setLoadingCourts] = useState(false);
    const [availableYears, setAvailableYears] = useState<string[]>([]);
    const [loadingYears, setLoadingYears] = useState(false);

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
                
                const refs: Record<TabKey, string | null> = { kanun: null, ciaa: null, press: null, court: null, dataset: null };
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
        // Dataset tab doesn't need loading from stubs
        if (tab === 'dataset') return;
        
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
        hasAttemptedLoadRef.current.add(tab);
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
        // Only auto-load non-court tabs (court tab requires user to apply filters first)
        // Use ref to prevent re-triggering on every render
        if (!rootLoading && activeTab !== 'court' && !hasAttemptedLoadRef.current.has(activeTab)) {
            const ref = stubs[activeTab];
            if (ref && manuscripts[activeTab] === null) {
                loadTab(activeTab);
            }
        }
    }, [activeTab, rootLoading, stubs, manuscripts, loadTab]);

    // Cleanup on unmount - abort all pending requests
    useEffect(() => {
        const controllers = abortControllersRef.current;
        return () => {
            controllers.forEach((controller) => controller.abort());
            controllers.clear();
        };
    }, []);

    // Fetch filtered court data
    const fetchFilteredCourtData = useCallback(async () => {
        if (!courtFilters.selectedCourt) {
            setTabErrors(prev => ({ ...prev, court: 'Please select a court' }));
            return;
        }

        const selectedCourtData = availableCourts.find(c => c.name === courtFilters.selectedCourt);
        if (!selectedCourtData) return;

        // Clear previous data and errors
        setManuscripts(prev => ({ ...prev, court: [] }));
        setTabErrors(prev => ({ ...prev, court: null }));
        setTabLoading(prev => ({ ...prev, court: true }));
        setIsStreamingData(prev => ({ ...prev, court: true }));

        const controller = new AbortController();
        abortControllersRef.current.set('court', controller);

        try {
            // Fetch court node to get years
            const courtRes = await fetch(getProxiedUrl(selectedCourtData.ref), { signal: controller.signal });
            if (!courtRes.ok) {
                throw new Error(`HTTP error! status: ${courtRes.status}`);
            }
            const courtNode: IndexNodeFull = await courtRes.json();

            if (!courtNode.children) {
                setManuscripts(prev => ({ ...prev, court: [] }));
                setTabLoading(prev => ({ ...prev, court: false }));
                setIsStreamingData(prev => ({ ...prev, court: false }));
                return;
            }

            // Filter years based on user selection
            let yearsToFetch = courtNode.children;
            
            console.log('Available years:', courtNode.children.map(c => c.name));
            
            if (courtFilters.startYear || courtFilters.endYear) {
                // Normalize user input years to full 4-digit format
                const normalizeYear = (input: string): number => {
                    // Try Devanagari first
                    const devanagariMatch = input.match(/[०-९]{4}/);
                    if (devanagariMatch) {
                        return parseInt(devanagariToAscii(devanagariMatch[0]), 10);
                    }
                    // Try 3-digit format (079 -> 2079)
                    const threeDigitMatch = input.match(/^\d{3}$/);
                    if (threeDigitMatch) {
                        return 2000 + parseInt(input, 10);
                    }
                    // Try 4-digit format (2079)
                    const fourDigitMatch = input.match(/^\d{4}$/);
                    if (fourDigitMatch) {
                        return parseInt(input, 10);
                    }
                    return NaN;
                };

                const startYear = courtFilters.startYear ? normalizeYear(courtFilters.startYear) : 0;
                const endYear = courtFilters.endYear ? normalizeYear(courtFilters.endYear) : 9999;

                if ((courtFilters.startYear && isNaN(startYear)) || (courtFilters.endYear && isNaN(endYear))) {
                    setTabErrors(prev => ({ ...prev, court: 'Invalid year format. Use 3-digit (079), 4-digit (2079), or Devanagari (२०६७)' }));
                    setTabLoading(prev => ({ ...prev, court: false }));
                    setIsStreamingData(prev => ({ ...prev, court: false }));
                    return;
                }

                yearsToFetch = courtNode.children.filter(child => {
                    // Extract year from name - could be "079", "080", etc. (3 digits)
                    // or "२०६७" (Devanagari 4 digits)
                    let year: number;
                    
                    // Try Devanagari first
                    const devanagariMatch = child.name.match(/[०-९]{4}/);
                    if (devanagariMatch) {
                        year = parseInt(devanagariToAscii(devanagariMatch[0]), 10);
                    } else {
                        // Try ASCII 3-digit format (079 -> 2079)
                        const asciiMatch = child.name.match(/\d{3}/);
                        if (asciiMatch) {
                            year = 2000 + parseInt(asciiMatch[0], 10);
                        } else {
                            console.log('No year match for:', child.name);
                            return false;
                        }
                    }
                    
                    console.log('Year filter:', { childName: child.name, year, startYear, endYear, passes: year >= startYear && year <= endYear });
                    
                    return year >= startYear && year <= endYear;
                });
                
                console.log('Filtered years:', yearsToFetch.map(y => y.name));
            }

            if (yearsToFetch.length === 0) {
                setManuscripts(prev => ({ ...prev, court: [] }));
                setTabLoading(prev => ({ ...prev, court: false }));
                setIsStreamingData(prev => ({ ...prev, court: false }));
                setTabErrors(prev => ({ ...prev, court: 'No data found for the selected filters' }));
                return;
            }

            // Fetch manuscripts for filtered years in parallel (faster loading)
            const allManuscripts: Manuscript[] = [];
            let totalPageCount = 0;

            // Process years in parallel batches for faster loading
            const PARALLEL_BATCH_SIZE = 3; // Fetch 3 years at a time
            
            for (let i = 0; i < yearsToFetch.length; i += PARALLEL_BATCH_SIZE) {
                const batch = yearsToFetch.slice(i, i + PARALLEL_BATCH_SIZE);
                
                // Fetch all years in this batch in parallel
                const batchResults = await Promise.all(
                    batch.map(async (yearNode) => {
                        const yearManuscripts = await fetchAllManuscriptsRecursive(
                            yearNode.$ref,
                            controller.signal,
                            () => {
                                totalPageCount++;
                                setLoadingProgress(prev => ({ ...prev, court: { current: totalPageCount, total: 0 } }));
                            },
                            () => {}, // Don't update during individual year fetch to avoid conflicts
                            FETCH_CONFIG.MAX_DEPTH,
                            FETCH_CONFIG.MAX_PAGES_PER_YEAR
                        );
                        return yearManuscripts;
                    })
                );
                
                // Add all manuscripts from this batch
                for (const yearManuscripts of batchResults) {
                    allManuscripts.push(...yearManuscripts);
                }
                
                // Update UI with accumulated results after each batch
                setManuscripts(prev => ({ ...prev, court: [...allManuscripts] }));
            }

            setManuscripts(prev => ({ ...prev, court: allManuscripts }));
            setIsStreamingData(prev => ({ ...prev, court: false }));
            setLoadingProgress(prev => ({ ...prev, court: null }));
        } catch (err: unknown) {
            if (err instanceof Error && (err.message === 'Request was cancelled' || err.name === 'AbortError')) {
                return;
            }
            const msg = err instanceof Error ? err.message : 'Failed to load court data';
            setTabErrors(prev => ({ ...prev, court: msg }));
            setIsStreamingData(prev => ({ ...prev, court: false }));
            setLoadingProgress(prev => ({ ...prev, court: null }));
        } finally {
            abortControllersRef.current.delete('court');
            setTabLoading(prev => ({ ...prev, court: false }));
        }
    }, [courtFilters, availableCourts]);

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

    // Load available courts when court tab is activated
    useEffect(() => {
        console.log('Court tab effect:', { activeTab, hasStub: !!stubs.court, courtsLength: availableCourts.length, loadingCourts });
        if (activeTab === 'court' && stubs.court && availableCourts.length === 0 && !loadingCourts) {
            console.log('Loading courts from:', stubs.court);
            setLoadingCourts(true);
            const controller = new AbortController();
            
            fetch(getProxiedUrl(stubs.court), { signal: controller.signal })
                .then(res => {
                    console.log('Courts response:', res.status, res.ok);
                    if (!res.ok) {
                        throw new Error(`HTTP error! status: ${res.status}`);
                    }
                    return res.json();
                })
                .then((node: IndexNodeFull) => {
                    console.log('Courts node:', node);
                    if (node.children) {
                        const courts = node.children.map(child => ({
                            name: child.name,
                            ref: child.$ref
                        }));
                        console.log('Setting available courts:', courts);
                        setAvailableCourts(courts);
                    } else {
                        console.warn('No children found in court node');
                    }
                    setLoadingCourts(false);
                })
                .catch(err => {
                    console.error('Failed to load courts - full error:', err);
                    // Always reset loading state on error, including AbortError
                    setLoadingCourts(false);
                    if (err.name !== 'AbortError') {
                        setTabErrors(prev => ({ ...prev, court: `Failed to load courts: ${err.message}` }));
                    }
                });
            
            return () => {
                console.log('Cleanup: aborting court fetch');
                controller.abort();
            };
        }
    }, [activeTab, stubs.court, availableCourts.length]);

    // Load available years when a court is selected
    useEffect(() => {
        if (courtFilters.selectedCourt) {
            const selectedCourtData = availableCourts.find(c => c.name === courtFilters.selectedCourt);
            if (selectedCourtData) {
                setLoadingYears(true);
                setAvailableYears([]);
                const controller = new AbortController();
                
                fetch(getProxiedUrl(selectedCourtData.ref), { signal: controller.signal })
                    .then(res => {
                        if (!res.ok) {
                            throw new Error(`HTTP error! status: ${res.status}`);
                        }
                        return res.json();
                    })
                    .then((node: IndexNodeFull) => {
                        if (node.children) {
                            // Extract and normalize years
                            const years = node.children.map(child => {
                                // Try Devanagari first
                                const devanagariMatch = child.name.match(/[०-९]{4}/);
                                if (devanagariMatch) {
                                    return devanagariToAscii(devanagariMatch[0]);
                                }
                                // Try ASCII 3-digit format (079 -> 2079)
                                const asciiMatch = child.name.match(/\d{3}/);
                                if (asciiMatch) {
                                    return String(2000 + parseInt(asciiMatch[0], 10));
                                }
                                return null;
                            }).filter((year): year is string => year !== null)
                              .sort((a, b) => parseInt(a) - parseInt(b));
                            
                            setAvailableYears(years);
                        }
                        setLoadingYears(false);
                    })
                    .catch(err => {
                        console.error('Failed to load years:', err);
                        setLoadingYears(false);
                        if (err.name !== 'AbortError') {
                            setTabErrors(prev => ({ ...prev, court: `Failed to load years: ${err.message}` }));
                        }
                    });
                
                return () => controller.abort();
            }
        } else {
            setAvailableYears([]);
        }
    }, [courtFilters.selectedCourt, availableCourts]);

    const renderCourtOrders = useCallback(() => {
        const items = manuscripts.court || [];
        const isLoading = tabLoading.court;
        
        console.log('Render court orders:', { 
            availableCourts: availableCourts.length, 
            loadingCourts, 
            selectedCourt: courtFilters.selectedCourt,
            items: items.length 
        });
        
        // Filter UI
        const filterUI = (
            <div style={{ 
                padding: '1.5rem', 
                background: '#f0f4ff', 
                borderRadius: '12px', 
                marginBottom: '1.5rem',
                border: '2px solid #bfdbfe'
            }}>
                <h3 style={{ color: '#1e40af', marginBottom: '1rem', fontSize: '1.1rem' }}>🔍 Filter Court Records</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '1rem', alignItems: 'end' }}>
                    <div>
                        <label htmlFor="court-select" style={{ display: 'block', color: '#1e40af', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>
                            Court * {loadingCourts && '(Loading...)'}
                        </label>
                        <select
                            id="court-select"
                            value={courtFilters.selectedCourt || ''}
                            onChange={(e) => {
                                console.log('Court selected:', e.target.value);
                                setCourtFilters(prev => ({ ...prev, selectedCourt: e.target.value || null }));
                            }}
                            style={{ 
                                width: '100%', 
                                padding: '0.6rem', 
                                borderRadius: '6px', 
                                border: '2px solid #bfdbfe',
                                background: '#ffffff',
                                fontSize: '0.95rem',
                                cursor: 'pointer'
                            }}
                            disabled={loadingCourts}
                        >
                            <option value="">Select a court...</option>
                            {availableCourts.map(court => (
                                <option key={court.name} value={court.name}>{court.name}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label htmlFor="start-year" style={{ display: 'block', color: '#1e40af', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>
                            Start Year (BS) {loadingYears && '(Loading...)'}
                        </label>
                        <select
                            id="start-year"
                            value={courtFilters.startYear}
                            onChange={(e) => setCourtFilters(prev => ({ ...prev, startYear: e.target.value }))}
                            style={{ 
                                width: '100%', 
                                padding: '0.6rem', 
                                borderRadius: '6px', 
                                border: '2px solid #bfdbfe',
                                background: '#ffffff',
                                fontSize: '0.95rem',
                                cursor: 'pointer'
                            }}
                            disabled={!courtFilters.selectedCourt || loadingYears}
                        >
                            <option value="">All years</option>
                            {availableYears.map(year => (
                                <option key={year} value={year}>{year}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label htmlFor="end-year" style={{ display: 'block', color: '#1e40af', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>
                            End Year (BS) {loadingYears && '(Loading...)'}
                        </label>
                        <select
                            id="end-year"
                            value={courtFilters.endYear}
                            onChange={(e) => setCourtFilters(prev => ({ ...prev, endYear: e.target.value }))}
                            style={{ 
                                width: '100%', 
                                padding: '0.6rem', 
                                borderRadius: '6px', 
                                border: '2px solid #bfdbfe',
                                background: '#ffffff',
                                fontSize: '0.95rem',
                                cursor: 'pointer'
                            }}
                            disabled={!courtFilters.selectedCourt || loadingYears}
                        >
                            <option value="">All years</option>
                            {availableYears.map(year => (
                                <option key={year} value={year}>{year}</option>
                            ))}
                        </select>
                    </div>
                    <button
                        onClick={() => {
                            console.log('Search button clicked');
                            fetchFilteredCourtData();
                        }}
                        disabled={!courtFilters.selectedCourt || isLoading}
                        style={{
                            padding: '0.6rem 1.5rem',
                            borderRadius: '6px',
                            border: 'none',
                            background: courtFilters.selectedCourt && !isLoading ? '#3b82f6' : '#cbd5e1',
                            color: 'white',
                            fontWeight: 600,
                            cursor: courtFilters.selectedCourt && !isLoading ? 'pointer' : 'not-allowed',
                            fontSize: '0.95rem',
                            transition: 'all 0.2s'
                        }}
                    >
                        {isLoading ? 'Loading...' : 'Search'}
                    </button>
                </div>
                {!courtFilters.selectedCourt && (
                    <p style={{ color: '#64748b', marginTop: '0.75rem', fontSize: '0.85rem', fontStyle: 'italic' }}>
                        💡 Select a court to load records. Optionally filter by year range.
                    </p>
                )}
            </div>
        );
        
        if (tabErrors.court) {
            return (
                <>
                    {filterUI}
                    <div className="state-container error fade-in" role="alert">
                        <p className="error-icon" aria-hidden="true">⚠️</p>
                        <p>{tabErrors.court}</p>
                    </div>
                </>
            );
        }
        
        // Show loading only if no data yet
        if (isLoading && items.length === 0) {
            return (
                <>
                    {filterUI}
                    {renderLoading('court')}
                </>
            );
        }
        
        if (!isLoading && items.length === 0) {
            return (
                <>
                    {filterUI}
                    <p className="empty-state">Select filters above to load court records.</p>
                </>
            );
        }

        // Transform data for table
        const tableData = items.map((item, index) => {
            // Extract case number from filename (e.g., "080-CR-0001.1.doc" -> "080-CR-0001")
            const caseMatch = item.file_name.match(/^(\d{3}-[A-Z]+-\d{4})/);
            const caseNumber = caseMatch ? caseMatch[1] : item.file_name;
            
            // Extract year from case number (e.g., "080-CR-0001" -> "080")
            const yearMatch = caseNumber.match(/^(\d{3})/);
            const year = yearMatch ? yearMatch[1] : 'N/A';
            
            return {
                id: index + 1,
                caseNumber,
                year,
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
                    if (year === 'N/A') return year;
                    // Year is in format "067" (3 digits) -> convert to "2067"
                    const yearNum = parseInt(year, 10);
                    // Use numeric addition to handle edge cases like 100 -> 2100
                    return String(2000 + yearNum);
                },
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
                {/* Show filter button when data is loaded */}
                <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <button
                        onClick={() => {
                            // Abort in-flight court loading when starting a new search
                            const existingController = abortControllersRef.current.get('court');
                            if (existingController) {
                                existingController.abort();
                                abortControllersRef.current.delete('court');
                            }
                            setManuscripts(prev => ({ ...prev, court: [] }));
                            setCourtFilters({ selectedCourt: null, startYear: '', endYear: '' });
                            setAvailableYears([]);
                            setTabErrors(prev => ({ ...prev, court: null }));
                            setTabLoading(prev => ({ ...prev, court: false }));
                            setIsStreamingData(prev => ({ ...prev, court: false }));
                        }}
                        style={{
                            padding: '0.5rem 1rem',
                            borderRadius: '6px',
                            border: '2px solid #3b82f6',
                            background: 'white',
                            color: '#3b82f6',
                            fontWeight: 600,
                            cursor: 'pointer',
                            fontSize: '0.9rem',
                            transition: 'all 0.2s'
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = '#3b82f6';
                            e.currentTarget.style.color = 'white';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'white';
                            e.currentTarget.style.color = '#3b82f6';
                        }}
                    >
                        ← New Search
                    </button>
                    <span style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 600 }}>
                        {items.length} records found
                    </span>
                </div>
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
    }, [tabLoading.court, tabErrors.court, manuscripts.court, isStreamingData.court, courtFilters, availableCourts, availableYears, loadingCourts, loadingYears, fetchFilteredCourtData, renderLoading]);

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
                <button
                    id="dataset-tab"
                    role="tab"
                    aria-selected={activeTab === 'dataset'}
                    aria-controls="dataset-panel"
                    className={`tab-btn ${activeTab === 'dataset' ? 'active' : ''}`}
                    onClick={() => {
                        setActiveTab('dataset');
                        setHasVisitedDataset(true);
                    }}
                >
                    CIAA Cases Dataset
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
                <div id="dataset-panel" role="tabpanel" aria-labelledby="dataset-tab" hidden={activeTab !== 'dataset'}>
                    {hasVisitedDataset && <CIAADatasetViewer />}
                </div>
            </div>
        </div>
    );
}