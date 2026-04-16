// ============================================================================
// IndexedDB Storage - For large datasets (19,000+ items)
// ============================================================================

type Manuscript = {
    url: string;
    file_name: string;
    metadata: Record<string, unknown>;
};

interface DBManuscript extends Manuscript {
    tab: string;
    timestamp: number;
    version: number; // Add version to track cache format changes
}

const DB_NAME = 'ngm_database';
const DB_VERSION = 1;
const STORE_NAME = 'manuscripts';
const CACHE_VERSION = 2; // Increment this to invalidate old caches

let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            dbInstance = request.result;
            resolve(request.result);
        };

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;

            // Create object store if it doesn't exist
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: ['tab', 'url'] });
                store.createIndex('tab', 'tab', { unique: false });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
}

export async function saveToIndexedDB(tab: string, manuscripts: Manuscript[]): Promise<void> {
    try {
        console.log(`💾 Saving ${manuscripts.length.toLocaleString()} items to IndexedDB for ${tab}...`);
        const startTime = Date.now();
        
        const db = await openDB();
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        // Clear existing data for this tab
        const index = store.index('tab');
        const range = IDBKeyRange.only(tab);
        const clearRequest = index.openCursor(range);

        clearRequest.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest).result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };

        // Add new data in chunks to avoid blocking
        const timestamp = Date.now();
        const CHUNK_SIZE = 1000;
        
        for (let i = 0; i < manuscripts.length; i += CHUNK_SIZE) {
            const chunk = manuscripts.slice(i, i + CHUNK_SIZE);
            chunk.forEach((manuscript) => {
                const dbItem: DBManuscript = {
                    ...manuscript,
                    tab,
                    timestamp,
                    version: CACHE_VERSION, // Add version to each item
                };
                store.put(dbItem);
            });
            
            // Log progress for large datasets
            if (manuscripts.length > 10000 && (i + CHUNK_SIZE) % 10000 === 0) {
                console.log(`💾 Saved ${(i + CHUNK_SIZE).toLocaleString()} / ${manuscripts.length.toLocaleString()} items...`);
            }
        }

        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => {
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`✅ Saved ${manuscripts.length.toLocaleString()} items to IndexedDB for ${tab} in ${duration}s`);
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);
        });
    } catch (err) {
        console.error('IndexedDB save error:', err);
    }
}

export async function loadFromIndexedDB(tab: string): Promise<Manuscript[] | null> {
    try {
        console.log(`📂 Loading ${tab} from IndexedDB...`);
        const startTime = Date.now();
        
        const db = await openDB();
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('tab');
        const range = IDBKeyRange.only(tab);

        return new Promise((resolve, reject) => {
            const request = index.getAll(range);

            request.onsuccess = () => {
                const results = request.result as DBManuscript[];
                
                if (results.length === 0) {
                    console.log(`📂 No cached data found for ${tab}`);
                    resolve(null);
                    return;
                }

                // Check cache version - invalidate if old version
                if (results[0].version !== CACHE_VERSION) {
                    console.log(`🔄 Cache version mismatch (found v${results[0].version || 1}, need v${CACHE_VERSION}). Invalidating cache...`);
                    resolve(null);
                    return;
                }

                // Check if data is stale (older than 7 days)
                const age = Date.now() - results[0].timestamp;
                const MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

                if (age > MAX_AGE) {
                    console.log(`⏰ IndexedDB data for ${tab} is stale (${Math.round(age / 1000 / 60 / 60 / 24)} days old)`);
                    resolve(null);
                    return;
                }

                // Remove tab, timestamp, and version fields
                const manuscripts = results.map(({ tab: _, timestamp: __, version: ___, ...manuscript }) => manuscript);
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log(`✅ Loaded ${manuscripts.length.toLocaleString()} items from IndexedDB for ${tab} in ${duration}s (${Math.round(age / 1000 / 60 / 60)} hours old)`);
                resolve(manuscripts);
            };

            request.onerror = () => reject(request.error);
        });
    } catch (err) {
        console.error('IndexedDB load error:', err);
        return null;
    }
}

export async function clearIndexedDB(tab?: string): Promise<void> {
    try {
        const db = await openDB();
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        if (tab) {
            // Clear specific tab
            const index = store.index('tab');
            const range = IDBKeyRange.only(tab);
            const request = index.openCursor(range);

            request.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
        } else {
            // Clear all
            store.clear();
        }

        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => {
                console.log(`🗑️ Cleared IndexedDB${tab ? ` for ${tab}` : ''}`);
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);
        });
    } catch (err) {
        console.error('IndexedDB clear error:', err);
    }
}
