import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

document.documentElement.style.cssText = 'background:transparent;overflow:hidden;height:100%'
document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden;height:100%'

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
)
