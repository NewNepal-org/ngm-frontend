import { useEffect, useCallback, useRef } from 'react';

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
export function useInfiniteScroll(
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
