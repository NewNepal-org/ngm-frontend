import { useState, useEffect } from 'react';

// Using standard structure defined in ngm implementation plan
type IndexEntry = {
    url: string;
    file_name: string;
    metadata?: Record<string, string>;
};

type PressReleaseFile = {
    url: string;
    file_name: string;
};

type PressRelease = {
    press_id: number;
    title: string;
    publication_date: string;
    source_url: string;
    full_text: string;
    files: PressReleaseFile[];
};

type GlobalIndex = {
    ciaa_annual_reports?: IndexEntry[];
    kanun_patrika?: IndexEntry[];
    ciaa_press_releases?: PressRelease[];
};

export default function IndexViewer() {
    const [data, setData] = useState<GlobalIndex | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'ciaa' | 'kanun' | 'press'>('kanun');

    useEffect(() => {
        fetch('https://ngm-store.newnepal.org/index.json')
            .then((res) => {
                if (!res.ok) throw new Error('Failed to fetch the NGM Index');
                return res.json();
            })
            .then((json: GlobalIndex) => {
                setData(json);
                setLoading(false);
            })
            .catch((err) => {
                setError(err.message || 'An unknown error occurred.');
                setLoading(false);
            });
    }, []);

    if (loading) {
        return (
            <div className="state-container bounce-in">
                <div className="spinner"></div>
                <p>Loading database...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="state-container error fade-in">
                <p className="error-icon">⚠️</p>
                <h2>Connection Error</h2>
                <p>{error}</p>
                <button className="btn-primary mt" onClick={() => window.location.reload()}>Retry</button>
            </div>
        );
    }

    const renderKanunPatrika = () => {
        const items = data?.kanun_patrika || [];
        if (items.length === 0) return <p className="empty-state">No records found for Kanun Patrika.</p>;

        return (
            <div className="list-view fade-in">
                {items.map((item, idx) => (
                    <a href={item.url} target="_blank" rel="noopener noreferrer" key={idx} className="list-item interactive">
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
        const items = data?.ciaa_annual_reports || [];
        if (items.length === 0) return <p className="empty-state">No records found for CIAA Annual Reports.</p>;

        return (
            <div className="list-view fade-in">
                {items.map((item, idx) => (
                    <a href={item.url} target="_blank" rel="noopener noreferrer" key={idx} className="list-item interactive">
                        <div className="list-icon">⚖️</div>
                        <div className="list-content">
                            <h3>{item.metadata?.title || item.file_name}</h3>
                            <div className="list-meta">
                                <span className="badge warning">CIAA</span>
                                <span className="meta-text">No. {item.metadata?.serial_number || 'N/A'}</span>
                                <span className="meta-text divider">•</span>
                                <span className="meta-text">{item.metadata?.date || 'Unknown Date'}</span>
                            </div>
                        </div>
                        <div className="list-action">→</div>
                    </a>
                ))}
            </div>
        );
    };

    const renderPressReleases = () => {
        const items = data?.ciaa_press_releases || [];
        if (items.length === 0) return <p className="empty-state">No records found for CIAA Press Releases.</p>;

        const getFileChipClass = (ext: string): string => {
            if (ext === 'PDF') return 'pdf';
            if (ext === 'DOC' || ext === 'DOCX') return 'doc';
            return 'default';
        };

        const extractFileExtension = (fileName: string): string => {
            const trimmed = fileName.trim();
            const match = trimmed.match(/\.([A-Za-z0-9]+)$/);
            return match ? match[1].toUpperCase() : 'FILE';
        };

        return (
            <div className="list-view fade-in">
                {items.map((item) => {
                    const files = Array.isArray(item.files) ? item.files : [];
                    return (
                        <div key={item.press_id} className="list-item">
                            <div className="list-icon">📰</div>
                            <div className="list-content">
                                <h3>{item.title}</h3>
                                <div className="list-meta">
                                    <span className="meta-text">No. {item.press_id}</span>
                                    {item.publication_date && (
                                        <>
                                            <span className="meta-text divider">•</span>
                                            <span className="meta-text">{item.publication_date}</span>
                                        </>
                                    )}
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
                                                    key={`${item.press_id}-${file.file_name}-${i}`}
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
