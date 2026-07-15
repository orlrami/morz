import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

/* Fonts — preset b3Z4dPIdAO roles: Geist (headings/UI), Noto Sans (body), JetBrains Mono (terminal). */
import '@fontsource-variable/geist'
import '@fontsource-variable/noto-sans'
import '@fontsource-variable/jetbrains-mono'

import './styles/globals.css'

/* Always dark — the .dark class is permanent (Phase-0 brief). */
document.documentElement.classList.add('dark')

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
