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

type TabKey = 'kanun' | 'ciaa' | 'press';

/**
 * Custom hook for infinite scroll using IntersectionObserver.
 *
 * Uses a callback ref for the sentinel element so the observer is always
 * attached to the current DOM node, even after tab switches remount it.
 *
 * @param callback - Function to call when sentinel element intersects viewport
 * @param hasMore - Whether more content is available to load
 * @param isLoading - Whether content is currently being loaded
 * @returns Callback ref to attach to the sentinel element
 */
function useInfiniteScroll(
    callback: () => void,
    hasMore: boolean,
    isLoading: boolean,
): (node: HTMLDivElement | null) => void {
    const observerRef = useRef<IntersectionObserver | null>(null);
    const callbackRef = useRef(callback);

    // Keep callback ref up to date without triggering observer re-creation
    useEffect(() => {
        callbackRef.current = callback;
    });

    // Callback ref — fires whenever the sentinel DOM node mounts or unmounts.
    // This guarantees the observer is always attached to the current element,
    // even after tab switches remount the sentinel with a new DOM node.
    const sentinelRef = useCallback(
        (node: HTMLDivElement | null) => {
            if (observerRef.current) {
                observerRef.current.disconnect();
                observerRef.current = null;
            }
            if (!node || !hasMore || isLoading) return;

            observerRef.current = new IntersectionObserver(
                (entries) => {
                    if (entries[0].isIntersecting) {
                        callbackRef.current();
                    }
                },
                { threshold: 0.1, rootMargin: '100px' },
            );
            observerRef.current.observe(node);
        },
        [hasMore, isLoading],
    );

    return sentinelRef;
}

/**
 * Fetch a page of manuscripts from a URL.
 *
 * @param url - URL to fetch the page from
 * @param signal - Optional AbortSignal for request cancellation
 * @returns Promise resolving to manuscripts array and optional next page URL
 */
async function fetchPage(
    url: string,
    signal?: AbortSignal,
): Promise<{ manuscripts: Manuscript[]; nextUrl?: string }> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Failed to fetch ${url}`);
    const node: IndexNodeFull = await res.json();
    return {
        manuscripts: node.manuscripts || [],
        nextUrl: node.next,
    };
}

const NODE_NAMES = {
    'kanun-patrika': 'kanun',
    'ciaa-annual-reports': 'ciaa',
    'ciaa-press-releases': 'press',
} as const;

export default function IndexViewer() {
    const [stubs, setStubs] = useState<Record<TabKey, string | null>>({ kanun: null, ciaa: null, press: null });
    const [manuscripts, setManuscripts] = useState<Record<TabKey, Manuscript[]>>({ kanun: [], ciaa: [], press: [] });
    const [nextUrls, setNextUrls] = useState<Record<TabKey, string | null>>({ kanun: null, ciaa: null, press: null });
    const [tabLoading, setTabLoading] = useState<Record<TabKey, boolean>>({ kanun: false, ciaa: false, press: false });
    const [loadingMore, setLoadingMore] = useState<Record<TabKey, boolean>>({ kanun: false, ciaa: false, press: false });
    const [tabInitialized, setTabInitialized] = useState<Record<TabKey, boolean>>({ kanun: false, ciaa: false, press: false });
    const [rootLoading, setRootLoading] = useState(true);
    const [rootError, setRootError] = useState<string | null>(null);
    const [tabErrors, setTabErrors] = useState<Record<TabKey, string | null>>({ kanun: null, ciaa: null, press: null });
    // Separate pagination errors so a failed "load more" doesn't hide already-loaded content
    const [tabPaginationErrors, setTabPaginationErrors] = useState<Record<TabKey, string | null>>({
        kanun: null,
        ciaa: null,
        press: null,
    });
    const [activeTab, setActiveTab] = useState<TabKey>('kanun');
    const loadingRef = useRef<Set<TabKey>>(new Set());
    // Synchronous lock for loadMore — prevents duplicate fetches when the
    // IntersectionObserver fires twice before React commits a state update.
    const loadingMoreRef = useRef<Set<TabKey>>(new Set());
    const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

    // Infinite scroll sentinels for each tab
    const kanunSentinel = useInfiniteScroll(
        () => loadMore('kanun'),
        !!nextUrls.kanun,
        loadingMore.kanun,
    );
    const ciaaSentinel = useInfiniteScroll(
        () => loadMore('ciaa'),
        !!nextUrls.ciaa,
        loadingMore.ciaa,
    );
    const pressSentinel = useInfiniteScroll(
        () => loadMore('press'),
        !!nextUrls.press,
        loadingMore.press,
    );

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

    // Lazy-load first page when a tab is first activated
    const loadTab = useCallback(
        async (tab: TabKey) => {
            const ref = stubs[tab];
            if (!ref || tabInitialized[tab] || loadingRef.current.has(tab)) return;

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
                const { manuscripts: items, nextUrl } = await fetchPage(ref, controller.signal);
                setManuscripts((prev) => ({ ...prev, [tab]: items }));
                setNextUrls((prev) => ({ ...prev, [tab]: nextUrl || null }));
                setTabInitialized((prev) => ({ ...prev, [tab]: true }));
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
        },
        [stubs, tabInitialized],
    );

    // Load more manuscripts (next page)
    const loadMore = useCallback(
        async (tab: TabKey) => {
            const nextUrl = nextUrls[tab];
            // Use synchronous ref lock — state check is not safe against concurrent
            // IntersectionObserver firings before React commits the update.
            if (!nextUrl || loadingMoreRef.current.has(tab)) return;
            loadingMoreRef.current.add(tab);

            const controller = new AbortController();
            abortControllersRef.current.set(`${tab}-more`, controller);

            setLoadingMore((prev) => ({ ...prev, [tab]: true }));

            try {
                const { manuscripts: items, nextUrl: newNextUrl } = await fetchPage(nextUrl, controller.signal);
                setManuscripts((prev) => ({ ...prev, [tab]: [...prev[tab], ...items] }));
                setNextUrls((prev) => ({ ...prev, [tab]: newNextUrl || null }));
                // Clear any previous pagination error on success
                setTabPaginationErrors((prev) => ({ ...prev, [tab]: null }));
            } catch (err: unknown) {
                if (err instanceof Error && (err.message === 'Request was cancelled' || err.name === 'AbortError')) {
                    return;
                }
                const msg = err instanceof Error ? err.message : 'Failed to load more';
                // Write to pagination errors, not tabErrors — keeps already-loaded content visible
                setTabPaginationErrors((prev) => ({ ...prev, [tab]: msg }));
            } finally {
                loadingMoreRef.current.delete(tab);
                abortControllersRef.current.delete(`${tab}-more`);
                setLoadingMore((prev) => ({ ...prev, [tab]: false }));
            }
        },
        [nextUrls],
    );

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
                <button className="btn-primary mt" onClick={() => window.location.reload()}>
                    Retry
                </button>
            </div>
        );
    }

    /**
     * Renders a loading spinner with message.
     */
    const renderLoading = () => (
        <div className="state-container bounce-in">
            <div className="spinner"></div>
            <p>Loading...</p>
        </div>
    );

    /**
     * Renders an inline pagination error with a retry button.
     * Shown near the sentinel so already-loaded content stays visible.
     */
    const renderPaginationError = (tab: TabKey) => (
        <div className="loading-more">
            <span>{tabPaginationErrors[tab]}</span>
            <button
                className="btn-primary"
                onClick={() => {
                    setTabPaginationErrors((prev) => ({ ...prev, [tab]: null }));
                    loadMore(tab);
                }}
            >
                Retry
            </button>
        </div>
    );

    /**
     * Renders the Kanun Patrika tab content with manuscripts list.
     * Handles loading, error, and empty states.
     */
    const renderKanunPatrika = () => {
        if (tabLoading.kanun) return renderLoading();
        if (tabErrors.kanun) {
            return (
                <div className="state-container error fade-in">
                    <p className="error-icon">⚠️</p>
                    <p>{tabErrors.kanun}</p>
                    <button
                        className="btn-primary mt"
                        onClick={() => {
                            setTabErrors((prev) => ({ ...prev, kanun: null }));
                            setTabInitialized((prev) => ({ ...prev, kanun: false }));
                            loadTab('kanun');
                        }}
                    >
                        Retry
                    </button>
                </div>
            );
        }
        const items = manuscripts.kanun;
        if (items.length === 0) return <p className="empty-state">No records found for Kanun Patrika.</p>;

        return (
            <div className="list-view fade-in">
                {items.map((item) => (
                    <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        key={item.url}
                        className="list-item interactive"
                    >
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
                {nextUrls.kanun && (
                    <div ref={kanunSentinel} className="scroll-sentinel">
                        {loadingMore.kanun && (
                            <div className="loading-more">
                                <div className="spinner-small"></div>
                                <span>Loading more...</span>
                            </div>
                        )}
                        {tabPaginationErrors.kanun && renderPaginationError('kanun')}
                    </div>
                )}
            </div>
        );
    };

    /**
     * Renders the CIAA Annual Reports tab content with manuscripts list.
     * Handles loading, error, and empty states. Sorts by date (newest first).
     */
    const renderCiaaReports = () => {
        if (tabLoading.ciaa) return renderLoading();
        if (tabErrors.ciaa) {
            return (
                <div className="state-container error fade-in">
                    <p className="error-icon">⚠️</p>
                    <p>{tabErrors.ciaa}</p>
                    <button
                        className="btn-primary mt"
                        onClick={() => {
                            setTabErrors((prev) => ({ ...prev, ciaa: null }));
                            setTabInitialized((prev) => ({ ...prev, ciaa: false }));
                            loadTab('ciaa');
                        }}
                    >
                        Retry
                    </button>
                </div>
            );
        }
        const items = manuscripts.ciaa;
        if (items.length === 0) return <p className="empty-state">No records found for CIAA Annual Reports.</p>;

        // Sort by date (newest first) - try multiple date fields
        const sortedItems = [...items].sort((a, b) => {
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
        });

        return (
            <div className="list-view fade-in">
                {sortedItems.map((item) => {
                    const meta = item.metadata as Record<string, string>;
                    return (
                        <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            key={item.url}
                            className="list-item interactive"
                        >
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
                {nextUrls.ciaa && (
                    <div ref={ciaaSentinel} className="scroll-sentinel">
                        {loadingMore.ciaa && (
                            <div className="loading-more">
                                <div className="spinner-small"></div>
                                <span>Loading more...</span>
                            </div>
                        )}
                        {tabPaginationErrors.ciaa && renderPaginationError('ciaa')}
                    </div>
                )}
            </div>
        );
    };

    /**
     * Renders the CIAA Press Releases tab content with grouped manuscripts.
     * Groups files by press_id and handles loading, error, and empty states.
     */
    const renderPressReleases = () => {
        if (tabLoading.press) return renderLoading();
        if (tabErrors.press) {
            return (
                <div className="state-container error fade-in">
                    <p className="error-icon">⚠️</p>
                    <p>{tabErrors.press}</p>
                    <button
                        className="btn-primary mt"
                        onClick={() => {
                            setTabErrors((prev) => ({ ...prev, press: null }));
                            setTabInitialized((prev) => ({ ...prev, press: false }));
                            loadTab('press');
                        }}
                    >
                        Retry
                    </button>
                </div>
            );
        }
        const items = manuscripts.press;
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
                    // Use groupKey as the React key — it is unique by construction
                    .map(([groupKey, { pressId, meta, files }]) => (
                        <div key={groupKey} className="list-item">
                            <div className="list-icon">📰</div>
                            <div className="list-content">
                                <h3>
                                    {String(meta?.title || `Press Release ${pressId ? `#${pressId}` : '(Unknown)'}`)}
                                </h3>
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
                    ))}
                {nextUrls.press && (
                    <div ref={pressSentinel} className="scroll-sentinel">
                        {loadingMore.press && (
                            <div className="loading-more">
                                <div className="spinner-small"></div>
                                <span>Loading more...</span>
                            </div>
                        )}
                        {tabPaginationErrors.press && renderPaginationError('press')}
                    </div>
                )}
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