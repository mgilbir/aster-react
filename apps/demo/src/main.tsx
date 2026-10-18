import React from 'react'
import { createRoot } from 'react-dom/client'
// The regression transform ships as an opt-in addon; load it before the demo
// compiles its specs. Geo is not used by the demo and stays unbundled.
import '@aster/core/transforms'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
