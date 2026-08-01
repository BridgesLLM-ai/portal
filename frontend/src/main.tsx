import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './contexts/ThemeContext'
import './index.css'
import 'highlight.js/styles/github-dark-dimmed.min.css'
// Theme overrides intentionally load after the Tailwind/base stylesheet so
// light mode can translate legacy dark-only utilities and syntax colors.
import './styles/themes.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
)
