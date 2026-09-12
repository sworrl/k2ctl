import { useEffect, useState } from 'react'
import { api, useStatus, type Profile, type Slot, type Box } from './api'
import CameraCard from './components/CameraCard'
import JobCard from './components/JobCard'
import TempsCard from './components/TempsCard'
import CfsCard from './components/CfsCard'
import ControlsCard from './components/ControlsCard'
import FansCard from './components/FansCard'
import SensorsCard from './components/SensorsCard'
import ModelCard from './components/ModelCard'
import ChamberCard from './components/ChamberCard'
import Backdrop from './components/Backdrop'
import SlotDialog from './components/SlotDialog'
import { Spotlight, Toasts, Confetti, CardTilt } from './components/Fx'

export default function App() {
  const { status, live, error } = useStatus()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [editing, setEditing] = useState<{ box: Box; slot: Slot } | null>(null)

  useEffect(() => { api.profiles().then(setProfiles).catch(() => setProfiles([])) }, [])

  const p = status?.printer
  const jobState = status?.job.state || 'standby'
  const online = !!status && (status.sources.moonraker || status.sources.cxws)

  return (
    <div className={`shell ${jobState}`}>
      <Backdrop active={jobState === 'printing'} />
      <Spotlight />
      <CardTilt />
      <Confetti fire={jobState === 'complete'} />
      <Toasts state={jobState} file={status?.job.file || ''} />
      <header className={`hero ${jobState}`}>
        <div className="hero-aurora" aria-hidden><i /><i /><i /></div>
        <div className="hero-inner">
          <img className="appicon" src="/favicon.png" alt="k2ctl" />
          <div className="who">
            <h1 className="shine">{p?.name || p?.hostname || 'K2'}</h1>
            <div className="sub">{p?.model || 'Creality K2'}{p?.klipper ? ` · Klipper ${p.klipper}` : ''}</div>
          </div>
          <div className="hero-state" data-state={status ? (online ? jobState : 'offline') : 'nolink'}>
            <span className="word">{status ? (online ? jobState : 'offline') : 'no link'}</span>
            {jobState === 'printing' && status && <span className="hero-pct">{status.job.progress.toFixed(0)}<small>%</small></span>}
          </div>
          <span className="pill quiet hide-sm" title="Moonraker / device socket / live updates">
            <i className={`dot ${status?.sources.moonraker ? 'on' : ''}`} /> Moonraker
            <i className={`dot ${status?.sources.cxws ? 'on' : ''}`} /> Device
            <i className={`dot ${live ? 'on' : ''}`} /> Live
          </span>
        </div>
        <div className="hero-energy" aria-hidden />
      </header>

      {error && <div className="banner"><i className="spin" /> {status ? 'Lost the backend, retrying' : 'Waiting for the backend'}: {error}</div>}

      {status ? (
        <div className="grid">
          <CameraCard className="span-8" />
          <div className="span-4" style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
            <JobCard status={status} />
            <TempsCard status={status} />
            <ControlsCard status={status} />
          </div>
          <ModelCard status={status} className="span-12" />
          <ChamberCard status={status} className="span-6" />
          <FansCard status={status} className="span-6" />
          <CfsCard status={status} className="span-12" onPick={(box, slot) => setEditing({ box, slot })} />
          {(status.errors ?? []).length > 0 && (
            <div className="card span-12"><h2>Device errors</h2><div className="errors">{(status.errors ?? []).map((e, i) => <div key={i}>{e}</div>)}</div></div>
          )}
          <SensorsCard status={status} className="span-12" />
        </div>
      ) : (
        <div className="grid"><CameraCard className="span-12" /></div>
      )}

      <div className="foot"><a href="https://falcontechnix.com" target="_blank" rel="noreferrer"><img src="/ft-logo.webp" alt="Falcon Technix" /></a><span>k2ctl</span><span>a Falcon Technix tool</span></div>

      {editing && status && (
        <SlotDialog box={editing.box} slot={editing.slot} profiles={profiles} printing={jobState === 'printing'}
          onClose={() => setEditing(null)} />
      )}
    </div>
  )
}
