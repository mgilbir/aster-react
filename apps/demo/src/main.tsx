import React from 'react'
import { createRoot } from 'react-dom/client'
// The regression transform ships as an opt-in addon; load it before the demo
// compiles its specs. Geo is the other opt-in add-on the demo uses (showcase.tsx and App.tsx import it for the maps).
import '@aster-charts/core/transforms'
// Vega-Lite support is opt-in in @aster-charts/react; the playground accepts VL specs.
import '@aster-charts/react/vl'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
