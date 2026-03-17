import { useState, useEffect } from 'react';
import client from '../api/client';

/**
 * Secure file content hook - fetches files with auth header, creates blob URLs
 * Use for image/video/audio previews
 */
export function useFileContent(fileId: string | null, mimeType?: string): {
  blobUrl: string | null;
  blob: Blob | null;
  loading: boolean;
  error: string | null;
} {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fileId) {
      setBlobUrl(null);
      setBlob(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let currentBlobUrl: string | null = null;

    async function fetchContent() {
      setLoading(true);
      setError(null);

      try {
        const response = await client.get(`/files/${fileId}/content`, {
          responseType: 'blob',
        });
        
        if (cancelled) return;
        
        // Check if we actually got blob data
        if (!response.data || response.data.size === 0) {
          throw new Error('Empty response from server');
        }
        
        console.log('[useFileContent] Loaded blob:', {
          fileId,
          size: response.data.size,
          type: response.data.type,
        });
        
        currentBlobUrl = URL.createObjectURL(response.data);
        setBlob(response.data);
        setBlobUrl(currentBlobUrl);
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        console.error('[useFileContent] Failed to load file content:', {
          fileId,
          error: err,
          response: err.response,
          status: err.response?.status,
          data: err.response?.data,
        });
        setBlob(null);
        setError(err.response?.data?.error || err.message || 'Failed to load file');
        setLoading(false);
      }
    }

    fetchContent();

    return () => {
      cancelled = true;
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  }, [fileId]);

  return { blobUrl, blob, loading, error };
}

/**
 * Hook for preview-on-demand (only loads when needed)
 */
export function useFilePreview(): {
  previewUrl: string | null;
  loadPreview: (fileId: string) => Promise<string>;
  clearPreview: () => void;
  loading: boolean;
  error: string | null;
} {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = async (fileId: string): Promise<string> => {
    setLoading(true);
    setError(null);

    try {
      const response = await client.get(`/files/${fileId}/content`, {
        responseType: 'blob',
      });
      
      const blobUrl = URL.createObjectURL(response.data);
      setPreviewUrl(blobUrl);
      setLoading(false);
      return blobUrl;
    } catch (err: any) {
      console.error('Failed to load preview:', err);
      const errorMsg = err.response?.data?.error || 'Failed to load preview';
      setError(errorMsg);
      setLoading(false);
      throw new Error(errorMsg);
    }
  };

  const clearPreview = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setError(null);
  };

  return { previewUrl, loadPreview, clearPreview, loading, error };
}
