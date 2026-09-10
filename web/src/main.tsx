import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import CameraCard from './components/CameraCard'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {location.pathname === '/camera' ? <div className="app"><CameraCard full /></div> : <App />}
  </React.StrictMode>,
)
