import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from './DataTable';

// Public R2 base URL for the CIAA dataset
const R2_BASE = import.meta.env.DEV
  ? '/output/ciaa_dataset'  // Local development: use local files
  : 'https://pub-4c5659ae2e0249e99311f6c50897f48a.r2.dev/test/v2/ciaa_dataset';  // Production: use R2 bucket

// Known fiscal years to try loading (format: "2080-81")
// Add more as the pipeline produces them
const KNOWN_FISCAL_YEARS = ['2080-81'];

// Convert Devanagari numerals to English numerals
const devanagariToEnglish = (str: string): string => {
  if (!str) return str;
  const devanagariMap: Record<string, string> = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
    '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
  };
  return str.replace(/[०-९]/g, (match) => devanagariMap[match] || match);
};

interface FYIndexCase {
  case_no: string;
  case_title: string;
  match_status: 'confirmed' | 'needs_review' | 'unmatched';
  registration_date_bs?: string;
  registration_date_ad?: string;
  current_status?: string;
  defendant_count?: number;
  press_release_count?: number;
  press_releases?: Array<{ release_id: number; url: string; title: string }>;
  abhiyog_patras?: Array<{ url: string }>;
  faisala_links?: string[];
}

interface FYIndex {
  fiscal_year: string;
  generated_at: string;
  stats: {
    total: number;
    matched: number;
    needs_review: number;
    unmatched: number;
  };
  cases: FYIndexCase[];
}

interface PressRelease {
  release_id: number;
  url: string;
  title: string;
  date?: string;
}

interface AbhiyogPatra {
  url?: string;
  pdf_url?: string;
  case_number?: string;
  title?: string;
  filing_date?: string;
  court_office?: string;
}

interface Defendant {
  name: string;
  address?: string;
}

interface Plaintiff {
  name: string;
  address?: string;
}

interface TableRow extends Record<string, unknown> {
  id: number;
  case_no: string;
  case_title: string;
  fiscal_year: string;
  match_status: string;
  case_url: string;
  registration_date_bs: string;
  registration_date_ad: string;
  faisala_date_bs?: string;
  faisala_date_ad?: string;
  defendant_count: number;
  press_release_count: number;
  press_releases: PressRelease[];
  abhiyog_patras: AbhiyogPatra[];
  faisala_links: string[];
  defendants?: Defendant[];
  plaintiffs?: Plaintiff[];
  appealed_case?: {
    court: string;
    case_no: string;
    registration_date_bs?: string;
    registration_date_ad?: string;
    current_status?: string;
    faisala_date_bs?: string;
    faisala_date_ad?: string;
    defendants?: Defendant[];
    plaintiffs?: Plaintiff[];
  };
}

export default function CIAADatasetViewer() {
  const [rows, setRows] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ fy: string; total: number; matched: number; needs_review: number; unmatched: number } | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const allRows: TableRow[] = [];
      const combinedStats = { total: 0, matched: 0, needs_review: 0, unmatched: 0 };
      let lastFY = '';
      let hasFirstBatch = false;

      for (const fy of KNOWN_FISCAL_YEARS) {
        if (signal?.aborted) return;
        
        const url = `${R2_BASE}/ciaa/cases/${fy}/index.json`;
        const res = await fetch(url, { signal });
        if (!res.ok) {
          console.warn(`No index for FY ${fy}: ${res.status}`);
          continue;
        }
        const index: FYIndex = await res.json();
        
        if (signal?.aborted) return;
        
        lastFY = index.fiscal_year;
        combinedStats.total += index.stats.total;
        combinedStats.matched += index.stats.matched;
        combinedStats.needs_review += index.stats.needs_review;
        combinedStats.unmatched += index.stats.unmatched;

        // Set stats immediately
        setStats({ fy: lastFY, ...combinedStats });

        // Filter confirmed cases
        const confirmedCases = index.cases.filter(c => c.match_status === 'confirmed');
        
        // Batch fetch case details (parallel requests, limit concurrency)
        const BATCH_SIZE = 10; // Fetch 10 at a time
        for (let i = 0; i < confirmedCases.length; i += BATCH_SIZE) {
          if (signal?.aborted) return;
          
          const batch = confirmedCases.slice(i, i + BATCH_SIZE);
          
          const batchPromises = batch.map(async (c) => {
            try {
              const caseUrl = `${R2_BASE}/ciaa/cases/${fy}/${c.case_no}.json`;
              const caseRes = await fetch(caseUrl, { signal });
              if (!caseRes.ok) return null;
              
              const caseData = await caseRes.json();
              
              return {
                id: 0, // Will be set later
                case_no: c.case_no,
                case_title: c.case_title,
                fiscal_year: index.fiscal_year,
                match_status: c.match_status,
                case_url: caseUrl,
                registration_date_bs: caseData.court_case?.registration_date_bs || 'N/A',
                registration_date_ad: caseData.court_case?.registration_date_ad || 'N/A',
                faisala_date_bs: caseData.court_case?.faisala_date_bs || null,
                faisala_date_ad: caseData.court_case?.faisala_date_ad || null,
                defendant_count: caseData.court_case?.defendants?.length || 0,
                press_release_count: (caseData.ciaa?.press_releases || []).length,
                press_releases: caseData.ciaa?.press_releases || [],
                abhiyog_patras: caseData.ciaa?.abhiyogPatras || [],
                faisala_links: caseData.court_case?.faisala_link || [],
                defendants: caseData.court_case?.defendants || [],
                plaintiffs: caseData.court_case?.plaintiffs || [],
                appealed_case: caseData.appealed_case || null,
              };
            } catch (err) {
              if (err instanceof Error && err.name === 'AbortError') return null;
              console.warn(`Error fetching case ${c.case_no}:`, err);
              return null;
            }
          });
          
          const batchResults = await Promise.all(batchPromises);
          
          if (signal?.aborted) return;
          
          const validResults = batchResults.filter(r => r !== null) as TableRow[];
          allRows.push(...validResults);
          
          // Update rows progressively after each batch
          setRows([...allRows].map((row, idx) => ({ ...row, id: idx + 1 })));
          
          // Clear loading after first successful batch
          if (!hasFirstBatch && validResults.length > 0) {
            hasFirstBatch = true;
            setLoading(false);
          }
        }
      }

      if (signal?.aborted) return;

      // Final update
      setRows(allRows.map((row, idx) => ({ ...row, id: idx + 1 })));
      if (allRows.length > 0) {
        setStats({ fy: lastFY, ...combinedStats });
      }
      setLoading(false);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'Failed to load CIAA dataset');
      setLoading(false);
    }
  };

  const startLoad = () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    void load(controller.signal);
  };

  useEffect(() => {
    startLoad();
    return () => abortControllerRef.current?.abort();
  }, []);

  const columns: ColumnDef<TableRow>[] = [
    {
      accessorKey: 'case_no',
      header: 'Case No.',
      size: 110,
      cell: (info) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ 
            color: '#9ca3af', 
            fontSize: '0.75rem',
            transition: 'transform 0.2s ease'
          }}>
            {expandedRows.has(info.row.original.id) ? '▼' : '▶'}
          </span>
          <a 
            href={info.row.original.case_url} 
            target="_blank" 
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 500 }}
          >
            {info.getValue() as string}
          </a>
        </div>
      ),
    },
    {
      accessorKey: 'case_title',
      header: 'Case Title',
      size: 250,
    },
    {
      id: 'raw_data',
      header: 'Raw Data',
      size: 100,
      enableColumnFilter: false,
      enableSorting: false,
      cell: (info) => (
        <a
          href={info.row.original.case_url}
          target="_blank"
          rel="noopener noreferrer"
          className="file-chip"
          style={{ background: '#e0e7ff', color: '#4338ca', borderColor: '#c7d2fe', textDecoration: 'none' }}
          title="View raw JSON data"
          onClick={(e) => e.stopPropagation()}
        >
          View JSON
        </a>
      ),
    },
    {
      id: 'documents',
      header: 'Related Documents',
      enableColumnFilter: false,
      enableSorting: false,
      cell: (info) => {
        const row = info.row.original;
        const docs: ReactNode[] = [];
        
        // Press Releases
        if (row.press_releases && row.press_releases.length > 0) {
          row.press_releases.forEach((pr, idx: number) => {
            docs.push(
              <a
                key={`pr-${idx}`}
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="file-chip"
                style={{ background: '#fef3c7', color: '#b45309', borderColor: '#fde68a' }}
                title={pr.title}
                onClick={(e) => e.stopPropagation()}
              >
                Press Release #{pr.release_id}
              </a>
            );
          });
        }
        
        // Abhiyog Patras
        if (row.abhiyog_patras && row.abhiyog_patras.length > 0) {
          row.abhiyog_patras.forEach((ap, idx: number) => {
            docs.push(
              <a
                key={`ap-${idx}`}
                href={ap.url}
                target="_blank"
                rel="noopener noreferrer"
                className="file-chip pdf"
                onClick={(e) => e.stopPropagation()}
              >
                Charge Sheet
              </a>
            );
          });
        }
        
        // Note: Faisala links are now shown in Case Information section
        
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {docs.length > 0 ? docs : <span style={{ color: '#64748b', fontSize: '0.8rem' }}>—</span>}
          </div>
        );
      },
    },
  ];

  const renderExpandedRow = (row: TableRow) => {
    if (!expandedRows.has(row.id)) return null;

    return (
      <tr key={`${row.id}-expanded`} style={{ background: '#f9fafb' }}>
        <td colSpan={columns.length} style={{ padding: 0 }}>
          <div style={{ 
            padding: '1rem 1.5rem', 
            borderTop: '2px solid #e5e7eb',
            animation: 'slide-down 0.2s ease-out'
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '1.5rem' }}>
              {/* Left Column */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

                {/* Card 1: Case Information */}
                <div>
                  <div style={{ fontWeight: 600, color: '#1f2937', marginBottom: '0.4rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span>📋</span> Case Information
                  </div>
                  <div style={{ background: '#fff', borderRadius: '6px', border: '1px solid #e5e7eb', padding: '0.75rem', fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#6b7280' }}>Registration Date (BS):</span>
                    <span style={{ fontWeight: 500, color: '#111827' }}>{row.registration_date_bs}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#6b7280' }}>Registration Date (AD):</span>
                    <span style={{ fontWeight: 500, color: '#111827' }}>{row.registration_date_ad}</span>
                  </div>
                  {row.faisala_date_bs && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#6b7280' }}>Faisala Date (BS):</span>
                      <span style={{ fontWeight: 500, color: '#111827' }}>{devanagariToEnglish(row.faisala_date_bs)}</span>
                    </div>
                  )}
                  {row.faisala_date_ad && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#6b7280' }}>Faisala Date (AD):</span>
                      <span style={{ fontWeight: 500, color: '#111827' }}>{devanagariToEnglish(row.faisala_date_ad)}</span>
                    </div>
                  )}
                  {row.faisala_links && row.faisala_links.length > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#6b7280' }}>Faisala:</span>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {row.faisala_links.map((link: string, idx: number) => {
                          const ext = link.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toUpperCase() || 'DOC';
                          return (
                            <a key={`faisala-${idx}`} href={link} target="_blank" rel="noopener noreferrer"
                              className="file-chip doc" style={{ fontSize: '0.75rem', padding: '0.2rem 0.4rem' }}
                              onClick={(e) => e.stopPropagation()}>
                              View ({ext})
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  </div>
                </div>

                {/* Card 2: Special Court */}
                {((row.plaintiffs && row.plaintiffs.length > 0) || (row.defendants && row.defendants.length > 0)) && (
                  <div>
                    <div style={{ fontWeight: 600, color: '#1f2937', marginBottom: '0.4rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span>🏛️</span> Special Court
                    </div>
                    <div style={{ background: '#fff', borderRadius: '6px', border: '1px solid #e5e7eb', padding: '0.75rem', fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {row.plaintiffs && row.plaintiffs.length > 0 && (
                      <div>
                        <div style={{ color: '#6b7280', fontSize: '0.72rem', marginBottom: '0.3rem' }}>⚖️ Plaintiffs ({row.plaintiffs.length})</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                          {row.plaintiffs.map((p, idx) => (
                            <span key={idx} style={{ padding: '0.2rem 0.45rem', background: '#eff6ff', borderRadius: '4px', border: '1px solid #bfdbfe', fontWeight: 500, color: '#1e40af', fontSize: '0.78rem' }} title={p.address || p.name}>{p.name}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {row.defendants && row.defendants.length > 0 && (
                      <div>
                        <div style={{ color: '#6b7280', fontSize: '0.72rem', marginBottom: '0.3rem' }}>👥 Defendants ({row.defendants.length})</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', maxHeight: '120px', overflowY: 'auto' }}>
                          {row.defendants.map((d, idx) => (
                            <span key={idx} style={{ padding: '0.2rem 0.45rem', background: '#f3f4f6', borderRadius: '4px', border: '1px solid #e5e7eb', fontWeight: 500, color: '#111827', fontSize: '0.78rem' }} title={d.address || d.name}>{d.name}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    </div>
                  </div>
                )}

                {/* Card 3: Supreme Court Appeal */}
                {row.appealed_case && (
                  <div>
                    <div style={{ fontWeight: 600, color: '#7c3aed', marginBottom: '0.4rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span>⚖️</span> Supreme Court (Appeal)
                    </div>
                    <div style={{ background: '#fff', borderRadius: '6px', border: '1px solid #e5e7eb', padding: '0.75rem', fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#6b7280' }}>Appeal Case No:</span>
                      <span style={{ fontWeight: 500, color: '#7c3aed' }}>{row.appealed_case.case_no}</span>
                    </div>
                    {row.appealed_case.registration_date_bs && (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#6b7280' }}>Appeal Filed (BS):</span>
                        <span style={{ fontWeight: 500, color: '#111827' }}>{row.appealed_case.registration_date_bs}</span>
                      </div>
                    )}
                    {row.appealed_case.plaintiffs && row.appealed_case.plaintiffs.length > 0 && (
                      <div>
                        <div style={{ color: '#6b7280', fontSize: '0.72rem', marginBottom: '0.3rem' }}>⚖️ Plaintiffs ({row.appealed_case.plaintiffs.length})</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                          {row.appealed_case.plaintiffs.map((p, idx) => (
                            <span key={idx} style={{ padding: '0.2rem 0.45rem', background: '#eff6ff', borderRadius: '4px', border: '1px solid #bfdbfe', fontWeight: 500, color: '#1e40af', fontSize: '0.78rem' }} title={p.address || p.name}>{p.name}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {row.appealed_case.defendants && row.appealed_case.defendants.length > 0 && (
                      <div>
                        <div style={{ color: '#6b7280', fontSize: '0.72rem', marginBottom: '0.3rem' }}>👥 Defendants ({row.appealed_case.defendants.length})</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', maxHeight: '120px', overflowY: 'auto' }}>
                          {row.appealed_case.defendants.map((d, idx) => (
                            <span key={idx} style={{ padding: '0.2rem 0.45rem', background: '#f3f4f6', borderRadius: '4px', border: '1px solid #e5e7eb', fontWeight: 500, color: '#111827', fontSize: '0.78rem' }} title={d.address || d.name}>{d.name}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  </div>
                )}
              </div>

              {/* Right Column */}
              <div>
                {row.press_releases && row.press_releases.length > 0 && (
                  <>
                    <h4 style={{ 
                      margin: '0 0 0.75rem 0', 
                      color: '#1f2937', 
                      fontSize: '0.875rem', 
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem'
                    }}>
                      <span style={{ fontSize: '1rem' }}>📰</span>
                      CIAA Press Release{row.press_releases.length > 1 ? 's' : ''} ({row.press_releases.length})
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {row.press_releases.map((pr, idx) => (
                        <div key={idx} style={{ 
                          padding: '0.75rem', 
                          background: '#fffbeb', 
                          borderRadius: '6px', 
                          border: '1px solid #fde68a',
                          fontSize: '0.8rem'
                        }}>
                          <div style={{ marginBottom: '0.5rem' }}>
                            <a 
                              href={pr.url} 
                              target="_blank" 
                              rel="noopener noreferrer" 
                              style={{ 
                                color: '#b45309', 
                                fontWeight: 600,
                                textDecoration: 'none',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem'
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              CIAA Press Release #{pr.release_id} →
                            </a>
                          </div>
                          <div style={{ color: '#78350f', lineHeight: '1.4' }}>{pr.title}</div>
                          {pr.date && (
                            <div style={{ 
                              color: '#92400e', 
                              fontSize: '0.75rem', 
                              marginTop: '0.5rem',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.25rem'
                            }}>
                              📅 {pr.date}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {row.abhiyog_patras && row.abhiyog_patras.length > 0 && (
                  <>
                    <h4 style={{ 
                      margin: '1rem 0 0.75rem 0', 
                      color: '#1f2937', 
                      fontSize: '0.875rem', 
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem'
                    }}>
                      <span style={{ fontSize: '1rem' }}>📄</span>
                      Charge Sheet{row.abhiyog_patras.length > 1 ? 's' : ''} ({row.abhiyog_patras.length})
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {row.abhiyog_patras.map((ap, idx) => (
                        <div key={idx} style={{ 
                          padding: '0.75rem', 
                          background: '#fef2f2', 
                          borderRadius: '6px', 
                          border: '1px solid #fecaca',
                          fontSize: '0.8rem'
                        }}>
                          <div style={{ marginBottom: '0.5rem' }}>
                            <a 
                              href={ap.pdf_url || ap.url} 
                              target="_blank" 
                              rel="noopener noreferrer" 
                              style={{ 
                                color: '#b91c1c', 
                                fontWeight: 600,
                                textDecoration: 'none',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem'
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {ap.title || `Charge Sheet ${ap.case_number || ''}`} →
                            </a>
                          </div>
                          {ap.filing_date && (
                            <div style={{ 
                              color: '#7f1d1d', 
                              fontSize: '0.75rem', 
                              marginTop: '0.5rem',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.25rem'
                            }}>
                              📅 Filed: {ap.filing_date}
                            </div>
                          )}
                          {ap.court_office && (
                            <div style={{ 
                              color: '#7f1d1d', 
                              fontSize: '0.75rem', 
                              marginTop: '0.25rem',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.25rem'
                            }}>
                              🏛️ {ap.court_office}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </td>
      </tr>
    );
  };

  if (loading) {
    return (
      <div className="state-container bounce-in" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true"></div>
        <p>Loading CIAA dataset...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="state-container error fade-in" role="alert">
        <p className="error-icon" aria-hidden="true">⚠️</p>
        <p>{error}</p>
        <button className="btn-primary" onClick={startLoad}>Retry</button>
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className="empty-state">No CIAA dataset records found.</p>;
  }

  return (
    <div className="fade-in">
      {stats && (
        <div style={{
          display: 'flex', gap: '1rem', flexWrap: 'wrap',
          padding: '1rem 1.25rem', background: '#f0fdf4',
          borderBottom: '1px solid #bbf7d0', fontSize: '0.8rem', fontWeight: 600,
        }}>
          <span style={{ color: '#374151' }}>Fiscal Year {stats.fy}</span>
          <span style={{ color: '#166534' }}>
            Showing {rows.length} verified cases linked with CIAA data
          </span>
        </div>
      )}
      <DataTable
        data={rows}
        columns={columns}
        pageSize={20}
        searchPlaceholder="Search by case number or title..."
        renderExpandedRow={renderExpandedRow}
        onRowClick={(row) => {
          const newExpandedRows = new Set(expandedRows);
          if (newExpandedRows.has(row.id)) {
            newExpandedRows.delete(row.id);
          } else {
            newExpandedRows.add(row.id);
          }
          setExpandedRows(newExpandedRows);
        }}
      />
    </div>
  );
}
