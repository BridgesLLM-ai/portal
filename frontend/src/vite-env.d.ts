/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_REMOTE_DESKTOP_URL?: string
  readonly VITE_REMOTE_DESKTOP_ALLOWED_PATH_PREFIXES?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
