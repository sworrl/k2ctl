import { useEffect, useRef, useState } from 'react'

// Live camera. The printer does non-trickle WebRTC over one HTTP round trip: we send a
// complete H.264 offer after ICE gathering, the backend relays it to the video service,
// the answer comes back in the same reply. Shown by default; the hide toggle is remembered
// per browser. Reconnects on its own with a growing delay.
const KEY = 'k2ctl.camera'
function remembered(): boolean { try { return localStorage.getItem(KEY) !== 'off' } catch { return true } }

export default function CameraCard({ full = false, className = '' }: { full?: boolean; className?: string }) {
  const [enabled, setEnabled] = useState<boolean>(remembered)
  const [state, setState] = useState('idle')
  const [meta, setMeta] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const timer = useRef<number | null>(null)
  const delay = useRef(3000)

  useEffect(() => {
    try { localStorage.setItem(KEY, enabled ? 'on' : 'off') } catch { /* ignore */ }
    if (!enabled) { teardown(); setState('hidden'); return }
    let cancelled = false
    const schedule = (fn: () => void) => {
      if (timer.current) clearTimeout(timer.current)
      const ms = delay.current
      delay.current = Math.min(delay.current * 2, 30000)
      setState(`retrying in ${Math.round(ms / 1000)}s`)
      timer.current = window.setTimeout(fn, ms)
    }
    const connect = async () => {
      teardown()
      setState('connecting'); setMeta('')
      const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })
      pcRef.current = pc
      const tr = pc.addTransceiver('video', { direction: 'sendrecv' })
      try {
        const caps = RTCRtpReceiver.getCapabilities('video')?.codecs ?? []
        const h264 = caps.filter(c => c.mimeType === 'video/H264' && /42e01f/i.test(c.sdpFmtpLine || '') && /packetization-mode=1/.test(c.sdpFmtpLine || ''))
        if (h264.length && 'setCodecPreferences' in tr) tr.setCodecPreferences(h264.slice(0, 1))
      } catch { /* codec preferences are optional */ }
      pc.ontrack = ev => {
        const v = videoRef.current
        if (v && v.srcObject !== ev.streams[0]) { v.srcObject = ev.streams[0]; v.play().catch(() => {}) }
      }
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState
        if (s === 'connected') { delay.current = 3000; setState('connected') }
        else if (s === 'failed' || s === 'disconnected' || s === 'closed') { if (!cancelled) schedule(connect) }
        else setState(s)
      }
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await new Promise<void>(res => {
          if (pc.iceGatheringState === 'complete') return res()
          const t = window.setTimeout(res, 2500)
          pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res() } }
        })
        const r = await fetch('/api/camera/offer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'offer', sdp: pc.localDescription?.sdp }) })
        if (!r.ok) throw new Error(`signaling ${r.status}`)
        const answer = await r.json()
        if (cancelled || pc.signalingState !== 'have-local-offer') return
        await pc.setRemoteDescription(new RTCSessionDescription(answer))
      } catch (e) {
        setState(`error: ${(e as Error).message}`)
        if (!cancelled) schedule(connect)
      }
    }
    void connect()
    const stats = window.setInterval(async () => {
      const pc = pcRef.current; if (!pc || pc.connectionState !== 'connected') return
      try {
        const st = await pc.getStats()
        st.forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'video' && s.frameWidth) setMeta(`${s.frameWidth}x${s.frameHeight}${s.framesPerSecond ? ` · ${s.framesPerSecond} fps` : ''}`) })
      } catch { /* ignore */ }
    }, 2000)
    return () => { cancelled = true; clearInterval(stats); teardown() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const teardown = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const pc = pcRef.current; pcRef.current = null
    if (pc) { pc.ontrack = null; pc.onconnectionstatechange = null; pc.close() }
    const v = videoRef.current; if (v) v.srcObject = null
  }
  const fullscreen = () => { const el = frameRef.current; if (!el) return; if (document.fullscreenElement) void document.exitFullscreen(); else void el.requestFullscreen?.() }
  const pill = state === 'connected' ? 'connected' : state.startsWith('error') || state.startsWith('retrying') ? 'failed' : ''

  return (
    <div className={`card camera ${className}`}>
      {enabled ? (
        <div ref={frameRef} className={`camera-frame ${full ? 'full' : ''}`}>
          <video ref={videoRef} autoPlay playsInline muted />
          <i className="hud-corner tl" /><i className="hud-corner tr" /><i className="hud-corner bl" /><i className="hud-corner br" />
          <i className="scanlines" />
          {state === 'connected' && <span className="rec"><i />LIVE</span>}
          {state !== 'connected' && <div className="camera-waiting"><span className="radar" />{state}</div>}
          <div className="camera-top">
            <h2>Camera</h2>
            <label className="chk" title="Hide the camera on this browser"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> show</label>
            <button className="iconbtn" onClick={fullscreen} title="Fullscreen" aria-label="Fullscreen"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" /></svg></button>
          </div>
          <div className="camera-hud">
            <span className={`pill ${pill}`}>{state}</span>
            <span className="grow" />
            {meta && <span className="meta">{meta}</span>}
          </div>
        </div>
      ) : (
        <div className="camera-off">
          <label className="chk"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> camera hidden on this browser. Tick to show it.</label>
        </div>
      )}
    </div>
  )
}
