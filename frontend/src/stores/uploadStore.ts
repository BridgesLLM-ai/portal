import { create } from 'zustand';
import { UploadProgress, UploadController } from '../utils/smartUpload';

export interface GlobalUpload {
  id: string;
  fileName: string;
  fileSize: number;
  progress: UploadProgress | null;
  status: 'uploading' | 'paused' | 'complete' | 'error';
  controller: UploadController;
  error?: string;
  route?: string;
}

interface UploadStore {
  uploads: Map<string, GlobalUpload>;
  setUpload: (id: string, upload: GlobalUpload) => void;
  updateUpload: (id: string, partial: Partial<GlobalUpload>) => void;
  removeUpload: (id: string) => void;
  getActiveCount: () => number;
}

export const useUploadStore = create<UploadStore>((set, get) => ({
  uploads: new Map(),
  setUpload: (id, upload) => set(state => {
    const next = new Map(state.uploads);
    next.set(id, upload);
    return { uploads: next };
  }),
  updateUpload: (id, partial) => set(state => {
    const next = new Map(state.uploads);
    const existing = next.get(id);
    if (existing) {
      next.set(id, { ...existing, ...partial });
    }
    return { uploads: next };
  }),
  removeUpload: (id) => set(state => {
    const next = new Map(state.uploads);
    next.delete(id);
    return { uploads: next };
  }),
  getActiveCount: () => {
    const { uploads } = get();
    let count = 0;
    uploads.forEach(u => {
      if (u.status === 'uploading' || u.status === 'paused') count++;
    });
    return count;
  },
}));
