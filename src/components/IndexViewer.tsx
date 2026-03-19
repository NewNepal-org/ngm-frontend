import { useState, useEffect, useCallback, useRef } from 'react';

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

/** Fetch all manuscripts for a node, following pagination via `next` links. */
async function fetchAllManuscripts(ref: string, signal?: AbortSignal): Promise<Manuscript[]> {
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

        const res = await fetch(url, { signal });
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
    const [rootLoading, setRootLoading] = useState(true);
    const [rootError, setRootError] = useState<string | null>(null);
    const [tabErrors, setTabErrors] = useState<Record<TabKey, string | null>>({ kanun: null, ciaa: null, press: null });
    const [activeTab, setActiveTab] = useState<TabKey>('kanun');
    const loadingRef = useRef<Set<TabKey>>(new Set());
    const abortControllersRef = useRef<Map<TabKey, AbortController>>(new Map());

    // Load root index once
    useEffect(() => {
        const controller = new AbortController();
        
        // Use local development server if available, fallback to production
        const indexUrl = import.meta.env.DEV 
            ? 'http://localhost:8001/index-v2.json'
            : 'https://ngm-store.newnepal.org/index-v2.json';
            
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
                    if (tab) refs[tab] = child.$ref;
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

        loadingRef.current.add(tab);
        setTabLoading((prev) => ({ ...prev, [tab]: true }));
        
        const controller = new AbortController();
        abortControllersRef.current.set(tab, controller);
        
        try {
            const items = await fetchAllManuscripts(ref, controller.signal);
            setManuscripts((prev) => ({ ...prev, [tab]: items }));
        } catch (err: unknown) {
            if (err instanceof Error && (err.message === 'Request was cancelled' || err.name === 'AbortError')) {
                return; // Don't set error for cancelled requests
            }
            const msg = err instanceof Error ? err.message : 'Failed to load data';
            setTabErrors((prev) => ({ ...prev, [tab]: msg }));
        } finally {
            abortControllersRef.current.delete(tab);
            loadingRef.current.delete(tab);
            setTabLoading((prev) => ({ ...prev, [tab]: false }));
        }
    }, [stubs, manuscripts]);

    useEffect(() => {
        if (!rootLoading) loadTab(activeTab);
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
                <button className="btn-primary mt" onClick={() => window.location.reload()}>Retry</button>
            </div>
        );
    }

    const renderLoading = () => (
        <div className="state-container bounce-in">
            <div className="spinner"></div>
            <p>Loading...</p>
        </div>
    );

    const renderKanunPatrika = () => {
        if (tabLoading.kanun) return renderLoading();
        if (tabErrors.kanun) {
            return (
                <div className="state-container error fade-in">
                    <p className="error-icon">⚠️</p>
                    <p>{tabErrors.kanun}</p>
                    <button className="btn-primary mt" onClick={() => {
                        setTabErrors(prev => ({ ...prev, kanun: null }));
                        loadTab('kanun');
                    }}>Retry</button>
                </div>
            );
        }
        const items = manuscripts.kanun || [];
        if (items.length === 0) return <p className="empty-state">No records found for Kanun Patrika.</p>;

        return (
            <div className="list-view fade-in">
                {items.map((item) => (
                    <a href={item.url} target="_blank" rel="noopener noreferrer" key={item.url} className="list-item interactive">
                        <div className="list-icon">🏛️</div>
                        <div className="list-content">
                            <h3>{item.file_name.replace('.pdf', '')}</h3>
                            <div className="list-meta">
                                <span className="badge">Supreme Court</span>
                            </div>
                        </div>
                        <div className="list-action">→</div>
                    </a>
                ))}
            </div>
        );
    };

    const renderCiaaReports = () => {
        if (tabLoading.ciaa) return renderLoading();
        if (tabErrors.ciaa) {
            return (
                <div className="state-container error fade-in">
                    <p className="error-icon">⚠️</p>
                    <p>{tabErrors.ciaa}</p>
                    <button className="btn-primary mt" onClick={() => {
                        setTabErrors(prev => ({ ...prev, ciaa: null }));
                        loadTab('ciaa');
                    }}>Retry</button>
                </div>
            );
        }
        const items = manuscripts.ciaa || [];
        if (items.length === 0) return <p className="empty-state">No records found for CIAA Annual Reports.</p>;

        // Sort by date (newest first) - try multiple date fields
        const sortedItems = [...items].sort((a, b) => {
            const rawDateA = a.metadata?.date ?? a.metadata?.year ?? null;
            const rawDateB = b.metadata?.date ?? b.metadata?.year ?? null;
            
            // If both have dates, compare them
            if (rawDateA && rawDateB) {
                const dateA = new Date(String(rawDateA));
                const dateB = new Date(String(rawDateB));
                
                // If both are valid dates, compare numerically
                if (!isNaN(dateA.getTime()) && !isNaN(dateB.getTime())) {
                    return dateB.getTime() - dateA.getTime(); // Newest first
                }
                
                // Fallback to string comparison
                return String(rawDateB).localeCompare(String(rawDateA));
            }
            
            // If only one has a date, prioritize the dated item
            if (rawDateA && !rawDateB) return -1;
            if (!rawDateA && rawDateB) return 1;
            
            // If neither has a date, fallback to filename comparison (reverse alphabetical)
            return b.file_name.localeCompare(a.file_name);
        });

        return (
            <div className="list-view fade-in">
                {sortedItems.map((item) => {
                    const meta = item.metadata as Record<string, string>;
                    return (
                        <a href={item.url} target="_blank" rel="noopener noreferrer" key={item.url} className="list-item interactive">
                            <div className="list-icon">⚖️</div>
                            <div className="list-content">
                                <h3>{meta?.title || item.file_name}</h3>
                                <div className="list-meta">
                                    <span className="badge warning">CIAA</span>
                                    <span className="meta-text">No. {meta?.serial_number || 'N/A'}</span>
                                    <span className="meta-text divider">•</span>
                                    <span className="meta-text">{meta?.date || 'Unknown Date'}</span>
                                </div>
                            </div>
                            <div className="list-action">→</div>
                        </a>
                    );
                })}
            </div>
        );
    };

    const renderPressReleases = () => {
        if (tabLoading.press) return renderLoading();
        if (tabErrors.press) {
            return (
                <div className="state-container error fade-in">
                    <p className="error-icon">⚠️</p>
                    <p>{tabErrors.press}</p>
                    <button className="btn-primary mt" onClick={() => {
                        setTabErrors(prev => ({ ...prev, press: null }));
                        loadTab('press');
                    }}>Retry</button>
                </div>
            );
        }
        const items = manuscripts.press || [];
        if (items.length === 0) return <p className="empty-state">No records found for CIAA Press Releases.</p>;

        const extractFileExtension = (fileName: string): string => {
            const match = fileName.trim().match(/\.([A-Za-z0-9]+)$/);
            return match ? match[1].toUpperCase() : 'FILE';
        };

        const getFileChipClass = (ext: string): string => {
            if (ext === 'PDF') return 'pdf';
            if (ext === 'DOC' || ext === 'DOCX') return 'doc';
            return 'default';
        };

        // Group manuscripts by press_id since each file is now its own Manuscript entry
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

        return (
            <div className="list-view fade-in">
                {[...grouped.entries()]
                    .sort(([, a], [, b]) => (b.pressId ?? -Infinity) - (a.pressId ?? -Infinity))
                    .map(([, { pressId, meta, files }]) => {
                    return (
                        <div key={`${pressId ?? 'unknown'}-${String(meta?.title ?? '')}`} className="list-item">
                            <div className="list-icon">📰</div>
                            <div className="list-content">
                                <h3>{String(meta?.title || `Press Release ${pressId ? `#${pressId}` : '(Unknown)'}`)}</h3>
                                <div className="list-meta">
                                    <span className="meta-text">No. {pressId ?? 'N/A'}</span>
                                    {meta?.publication_date ? (
                                        <>
                                            <span className="meta-text divider">•</span>
                                            <span className="meta-text">{String(meta.publication_date)}</span>
                                        </>
                                    ) : null}
                                </div>

                                {files.length > 0 && (
                                    <div className="pr-files">
                                        {files.map((file, i) => {
                                            const ext = extractFileExtension(file.file_name);
                                            const match = file.file_name.trim().match(/ - (\d+)\.\w+$/);
                                            const num = match ? match[1] : i + 1;
                                            return (
                                                <a
                                                    href={file.url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    key={file.url}
                                                    className={`file-chip ${getFileChipClass(ext)}`}
                                                >
                                                    {ext} · File {num}
                                                </a>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
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