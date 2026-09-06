import React from 'react'
import { createRoot } from 'react-dom/client'
import '@aster/core/transforms'
import '@aster/core/geo'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
