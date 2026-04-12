import { useState, useEffect } from 'react';
import client from '../api/client';

/**
 * Secure thumbnail hook - fetches images with auth header, creates blob URLs
 * Prevents token exposure via query parameters
 */
export function useThumbnail(fileId: string | null): string | null {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!fileId) return;

    let cancelled = false;
    let currentBlobUrl: string | null = null;

    async function fetchThumbnail() {
      try {
        const response = await client.get(`/files/${fileId}/thumbnail`, {
          responseType: 'blob',
        });
        
        if (cancelled) return;
        
        currentBlobUrl = URL.createObjectURL(response.data);
        setBlobUrl(currentBlobUrl);
      } catch (error) {
        console.error('Failed to load thumbnail:', error);
        setBlobUrl(null);
      }
    }

    fetchThumbnail();

    return () => {
      cancelled = true;
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  }, [fileId]);

  return blobUrl;
}

/**
 * Batch thumbnail loader - fetches multiple thumbnails efficiently
 */
export function useThumbnails(fileIds: string[]): Record<string, string> {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  useEffect(() => {
    const blobUrls: Record<string, string> = {};
    let cancelled = false;
    const queue = [...fileIds];
    const concurrency = 4;

    setThumbnails((prev) => {
      const next: Record<string, string> = {};
      for (const fileId of fileIds) {
        if (prev[fileId]) next[fileId] = prev[fileId];
      }
      return next;
    });

    async function fetchOne(fileId: string) {
      try {
        const response = await client.get(`/files/${fileId}/thumbnail`, {
          responseType: 'blob',
        });

        if (cancelled) return;

        const blobUrl = URL.createObjectURL(response.data);
        blobUrls[fileId] = blobUrl;

        setThumbnails(prev => {
          if (prev[fileId] === blobUrl) return prev;
          return { ...prev, [fileId]: blobUrl };
        });
      } catch (error) {
        console.error(`Failed to load thumbnail for ${fileId}:`, error);
      }
    }

    async function worker() {
      while (!cancelled) {
        const fileId = queue.shift();
        if (!fileId) return;
        await fetchOne(fileId);
      }
    }

    void Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

    return () => {
      cancelled = true;
      Object.values(blobUrls).forEach(url => URL.revokeObjectURL(url));
    };
  }, [fileIds.join(',')]);

  return thumbnails;
}
