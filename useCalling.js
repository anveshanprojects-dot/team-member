import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_SERVER_URL?.trim()
const DEFAULT_STUN_URLS = (import.meta.env.VITE_STUN_URLS || 'stun:stun.l.google.com:19302')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean)

function mediaErrorMessage(error, callType) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Allow microphone and camera access in your browser, then try the call again.'
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return callType === 'video' ? 'A microphone or camera could not be found.' : 'A microphone could not be found.'
  }
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
    return 'Your microphone or camera is being used by another app.'
  }
  return error?.message || 'Could not start your microphone or camera.'
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => {
    if (!socket?.connected) {
      resolve({ ok: false, code: 'disconnected', error: 'The calling service is disconnected.' })
      return
    }
    socket.timeout(5_000).emit(event, payload, (timeoutError, response) => {
      if (timeoutError) {
        resolve({ ok: false, code: 'timeout', error: 'The calling service did not respond.' })
        return
      }
      resolve(response || { ok: false, code: 'invalid_response', error: 'The calling service returned no response.' })
    })
  })
}

export function useCalling(session, profile, notify, blockedUserIds = []) {
  const [connectionStatus, setConnectionStatus] = useState(SIGNALING_URL ? 'connecting' : 'unconfigured')
  const [presence, setPresence] = useState({})
  const [call, setCall] = useState(null)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [microphoneMuted, setMicrophoneMuted] = useState(false)
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [speakerEnabled, setSpeakerEnabled] = useState(true)
  const [manualBusy, setManualBusy] = useState(false)
  const socketRef = useRef(null)
  const callRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const localStreamRef = useRef(null)
  const remoteStreamRef = useRef(null)
  const pendingIceRef = useRef([])
  const iceConfigurationRef = useRef({ iceServers: DEFAULT_STUN_URLS.length ? [{ urls: DEFAULT_STUN_URLS }] : [] })
  const disconnectTimerRef = useRef(null)
  const connectionTimerRef = useRef(null)
  const sessionRef = useRef(session)
  const profileRef = useRef(profile)
  const notifyRef = useRef(notify)
  const blockedUserIdsRef = useRef(blockedUserIds)
  const lastConnectionErrorRef = useRef('')

  sessionRef.current = session
  profileRef.current = profile
  notifyRef.current = notify
  blockedUserIdsRef.current = blockedUserIds

  const updateCall = useCallback((callId, updates) => {
    const current = callRef.current
    if (!current || (callId && current.callId !== callId)) return
    const next = { ...current, ...updates }
    callRef.current = next
    setCall(next)
  }, [])

  const resetCall = useCallback(() => {
    window.clearTimeout(disconnectTimerRef.current)
    disconnectTimerRef.current = null
    window.clearTimeout(connectionTimerRef.current)
    connectionTimerRef.current = null
    const peerConnection = peerConnectionRef.current
    peerConnectionRef.current = null
    if (peerConnection) {
      peerConnection.onicecandidate = null
      peerConnection.ontrack = null
      peerConnection.onconnectionstatechange = null
      peerConnection.oniceconnectionstatechange = null
      peerConnection.close()
    }
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    remoteStreamRef.current = null
    pendingIceRef.current = []
    callRef.current = null
    setCall(null)
    setLocalStream(null)
    setRemoteStream(null)
    setMicrophoneMuted(false)
    setCameraEnabled(false)
    setSpeakerEnabled(true)
  }, [])

  const sendCallEnd = useCallback((eventName, callId) => {
    const socket = socketRef.current
    if (socket?.connected && callId) socket.emit(eventName, { callId })
  }, [])

  const createPeerConnection = useCallback((callId, stream) => {
    const peerConnection = new window.RTCPeerConnection(iceConfigurationRef.current)
    const receivedStream = new window.MediaStream()
    peerConnectionRef.current = peerConnection
    remoteStreamRef.current = receivedStream
    window.clearTimeout(connectionTimerRef.current)
    connectionTimerRef.current = window.setTimeout(() => {
      if (peerConnectionRef.current === peerConnection && peerConnection.connectionState !== 'connected' && callRef.current?.callId === callId) {
        notifyRef.current('The call could not connect before the connection timeout.')
        sendCallEnd('call:end', callId)
        resetCall()
      }
    }, 30_000)
    setRemoteStream(receivedStream)
    stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream))
    peerConnection.ontrack = (event) => {
      const incomingStream = event.streams?.[0]
      if (incomingStream) {
        remoteStreamRef.current = incomingStream
        setRemoteStream(incomingStream)
      } else if (remoteStreamRef.current && !remoteStreamRef.current.getTracks().some((track) => track.id === event.track.id)) {
        remoteStreamRef.current.addTrack(event.track)
        setRemoteStream(new window.MediaStream(remoteStreamRef.current.getTracks()))
      }
    }
    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) return
      const socket = socketRef.current
      socket?.emit('webrtc:ice', { callId, candidate: event.candidate.toJSON() }, (response) => {
        if (response && !response.ok) notifyRef.current(response.error || 'Could not send a network candidate.')
      })
    }
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState
      updateCall(callId, { connectionState: state })
      if (state === 'connected') {
        window.clearTimeout(connectionTimerRef.current)
        connectionTimerRef.current = null
        window.clearTimeout(disconnectTimerRef.current)
        disconnectTimerRef.current = null
        updateCall(callId, { phase: 'active', connectedAt: callRef.current?.connectedAt || Date.now(), connectionState: state })
      } else if (state === 'failed') {
        notifyRef.current('The call connection failed. Check your network or TURN configuration.')
        sendCallEnd('call:end', callId)
        resetCall()
      }
    }
    peerConnection.oniceconnectionstatechange = () => {
      if (peerConnection.iceConnectionState === 'disconnected') {
        window.clearTimeout(disconnectTimerRef.current)
        disconnectTimerRef.current = window.setTimeout(() => {
          if (peerConnectionRef.current === peerConnection && peerConnection.iceConnectionState === 'disconnected') {
            notifyRef.current('The call disconnected because the network connection was lost.')
            sendCallEnd('call:end', callId)
            resetCall()
          }
        }, 8_000)
      } else if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
        window.clearTimeout(disconnectTimerRef.current)
        disconnectTimerRef.current = null
      }
    }
    return peerConnection
  }, [resetCall, sendCallEnd, updateCall])

  const addPendingIceCandidates = useCallback(async (peerConnection) => {
    const candidates = pendingIceRef.current.splice(0)
    for (const candidate of candidates) await peerConnection.addIceCandidate(candidate)
  }, [])

  const startCallerMedia = useCallback(async (callSnapshot) => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
        throw new Error('This browser does not support WebRTC calling.')
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: callSnapshot.type === 'video' ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      })
      if (callRef.current?.callId !== callSnapshot.callId) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      localStreamRef.current = stream
      setLocalStream(stream)
      setMicrophoneMuted(false)
      setCameraEnabled(callSnapshot.type === 'video')
      const peerConnection = createPeerConnection(callSnapshot.callId, stream)
      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)
      const response = await emitWithAck(socketRef.current, 'webrtc:offer', {
        callId: callSnapshot.callId,
        description: peerConnection.localDescription,
      })
      if (!response.ok) throw new Error(response.error || 'Could not send the call offer.')
    } catch (error) {
      if (callRef.current?.callId !== callSnapshot.callId) return
      notifyRef.current(mediaErrorMessage(error, callSnapshot.type))
      sendCallEnd('call:end', callSnapshot.callId)
      resetCall()
    }
  }, [createPeerConnection, resetCall, sendCallEnd])

  const applyRemoteDescription = useCallback(async (payload, expectedType) => {
    const peerConnection = peerConnectionRef.current
    if (!payload?.callId || callRef.current?.callId !== payload.callId || !peerConnection || payload.description?.type !== expectedType) return
    try {
      await peerConnection.setRemoteDescription(payload.description)
      await addPendingIceCandidates(peerConnection)
      if (expectedType === 'offer') {
        const answer = await peerConnection.createAnswer()
        await peerConnection.setLocalDescription(answer)
        const response = await emitWithAck(socketRef.current, 'webrtc:answer', {
          callId: payload.callId,
          description: peerConnection.localDescription,
        })
        if (!response.ok) throw new Error(response.error || 'Could not send the call answer.')
      }
    } catch (error) {
      notifyRef.current(`Could not establish the call: ${error.message}`)
      sendCallEnd('call:end', payload.callId)
      resetCall()
    }
  }, [addPendingIceCandidates, resetCall, sendCallEnd])

  useEffect(() => {
    if (!session?.user?.id) {
      setConnectionStatus(SIGNALING_URL ? 'disconnected' : 'unconfigured')
      setPresence({})
      setManualBusy(false)
      resetCall()
      return undefined
    }
    if (!SIGNALING_URL) {
      setConnectionStatus('unconfigured')
      return undefined
    }
    let active = true
    const socket = io(SIGNALING_URL, {
      auth: (callback) => callback({
        accessToken: sessionRef.current?.access_token,
        showOnlineStatus: profileRef.current?.show_online_status === true,
      }),
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: 10_000,
    })
    socketRef.current = socket
    socket.on('connect', () => {
      lastConnectionErrorRef.current = ''
      if (active) setConnectionStatus('connected')
      socket.timeout(5_000).emit('presence:set_visibility', {
        visible: profileRef.current?.show_online_status === true,
      }, (error, response) => {
        if (error) notifyRef.current('Could not update calling availability visibility.')
        else if (!response?.ok) notifyRef.current(response?.error || 'Could not update calling availability visibility.')
      })
    })
    socket.on('disconnect', () => {
      if (active) setConnectionStatus('disconnected')
      if (callRef.current) {
        notifyRef.current('The calling service disconnected; the call ended.')
        resetCall()
      }
    })
    socket.on('connect_error', (error) => {
      if (active) setConnectionStatus('disconnected')
      if (error?.message && lastConnectionErrorRef.current !== error.message) {
        lastConnectionErrorRef.current = error.message
        notifyRef.current(`Calling service: ${error.message}`)
      }
    })
    socket.on('presence:snapshot', (entries) => {
      if (!Array.isArray(entries)) return
      const next = {}
      for (const entry of entries) {
        if (entry && typeof entry.userId === 'string' && ['online', 'offline', 'busy', 'in_call'].includes(entry.status)) {
          next[entry.userId] = entry.status
        }
      }
      if (active) setPresence(next)
    })
    socket.on('presence:update', (entry) => {
      if (!entry || typeof entry.userId !== 'string' || !['online', 'offline', 'busy', 'in_call'].includes(entry.status)) return
      if (active) setPresence((current) => ({ ...current, [entry.userId]: entry.status }))
    })
    socket.on('webrtc:config', (configuration) => {
      if (!Array.isArray(configuration?.iceServers)) return
      iceConfigurationRef.current = { iceServers: configuration.iceServers }
    })
    socket.on('call:incoming', (payload) => {
      if (!payload?.callId || !payload.caller?.userId || !['audio', 'video'].includes(payload.callType)) return
      if (blockedUserIdsRef.current.includes(payload.caller.userId)) {
        socket.emit('call:reject', { callId: payload.callId }, (response) => {
          if (response && !response.ok && response.code !== 'call_unavailable') notifyRef.current(response.error || 'Could not decline the blocked caller.')
        })
        return
      }
      if (callRef.current) {
        socket.emit('call:reject', { callId: payload.callId })
        return
      }
      const incoming = {
        callId: payload.callId,
        peerId: payload.caller.userId,
        peerName: payload.caller.name || 'Anveshan member',
        peerAvatar: payload.caller.avatarUrl || '',
        type: payload.callType,
        phase: 'incoming',
        connectionState: 'new',
        connectedAt: null,
      }
      callRef.current = incoming
      setCall(incoming)
    })
    socket.on('call:accepted', (payload) => {
      const current = callRef.current
      if (!current || current.callId !== payload?.callId || current.phase !== 'outgoing') return
      updateCall(payload.callId, { phase: 'connecting', connectionState: 'connecting' })
      void startCallerMedia({ ...current, phase: 'connecting' })
    })
    socket.on('call:accepted_elsewhere', (payload) => {
      if (callRef.current?.callId !== payload?.callId) return
      notifyRef.current('The call was answered on another device.')
      resetCall()
    })
    socket.on('call:rejected', (payload) => {
      if (callRef.current?.callId !== payload?.callId) return
      notifyRef.current('Your call was declined.')
      resetCall()
    })
    socket.on('call:timeout', (payload) => {
      if (callRef.current?.callId !== payload?.callId) return
      notifyRef.current('There was no answer.')
      resetCall()
    })
    socket.on('call:missed', (payload) => {
      if (callRef.current?.callId !== payload?.callId) return
      notifyRef.current('Missed call.')
      resetCall()
    })
    socket.on('call:cancelled', (payload) => {
      if (callRef.current?.callId !== payload?.callId) return
      notifyRef.current('The caller cancelled the call.')
      resetCall()
    })
    socket.on('call:ended', (payload) => {
      if (callRef.current?.callId !== payload?.callId) return
      if (payload.reason === 'disconnected') notifyRef.current('The other person disconnected.')
      else if (payload.reason === 'rejected') notifyRef.current('The call was declined.')
      else if (payload.reason === 'ended') notifyRef.current('The call ended.')
      resetCall()
    })
    socket.on('webrtc:offer', (payload) => { void applyRemoteDescription(payload, 'offer') })
    socket.on('webrtc:answer', (payload) => { void applyRemoteDescription(payload, 'answer') })
    socket.on('webrtc:ice', async (payload) => {
      if (!payload?.candidate || callRef.current?.callId !== payload.callId) return
      try {
        const candidate = new window.RTCIceCandidate(payload.candidate)
        if (peerConnectionRef.current?.remoteDescription) await peerConnectionRef.current.addIceCandidate(candidate)
        else pendingIceRef.current.push(candidate)
      } catch (error) {
        notifyRef.current(`Could not add a network candidate: ${error.message}`)
      }
    })
    socket.on('call:error', (payload) => {
      if (payload?.error) notifyRef.current(payload.error)
    })

    return () => {
      active = false
      socket.removeAllListeners()
      socket.disconnect()
      if (socketRef.current === socket) socketRef.current = null
      resetCall()
    }
  }, [applyRemoteDescription, resetCall, session?.user?.id, startCallerMedia, updateCall])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket?.connected) return
    socket.timeout(5_000).emit('presence:set_visibility', {
      visible: profile?.show_online_status === true,
    }, (error, response) => {
      if (error) notifyRef.current('Could not update calling availability visibility.')
      else if (!response?.ok) notifyRef.current(response?.error || 'Could not update calling availability visibility.')
    })
  }, [profile?.show_online_status])

  const startCall = useCallback(async (person, type) => {
    const socket = socketRef.current
    if (!['audio', 'video'].includes(type) || !person?.id) return false
    if (blockedUserIdsRef.current.includes(person.id)) {
      notifyRef.current('Unblock this person before calling them.')
      return false
    }
    if (!socket?.connected || connectionStatus !== 'connected') {
      notifyRef.current('The calling service is not connected.')
      return false
    }
    if (presence[person.id] !== 'online') {
      notifyRef.current(presence[person.id] === 'busy' || presence[person.id] === 'in_call'
        ? 'This person is busy.'
        : 'This person is offline.')
      return false
    }
    if (callRef.current) {
      notifyRef.current('End your current call before starting another.')
      return false
    }
    const outgoing = {
      requestId: crypto.randomUUID(),
      callId: null,
      peerId: person.id,
      peerName: person.full_name || person.username || 'Anveshan member',
      peerAvatar: person.avatar_url || '',
      type,
      phase: 'outgoing',
      connectionState: 'new',
      connectedAt: null,
    }
    callRef.current = outgoing
    setCall(outgoing)
    const result = await emitWithAck(socket, 'call:invite', {
      toUserId: person.id,
      callType: type,
      callerProfile: {
        name: profileRef.current?.full_name || profileRef.current?.username || 'Anveshan member',
        avatarUrl: profileRef.current?.avatar_url || '',
      },
    })
    if (!result.ok) {
      if (callRef.current?.requestId === outgoing.requestId) {
        resetCall()
        notifyRef.current(result.error || 'Could not start the call.')
      }
      return false
    }
    if (callRef.current?.requestId !== outgoing.requestId) {
      sendCallEnd('call:cancel', result.callId)
      return false
    }
    updateCall(null, { callId: result.callId })
    return true
  }, [connectionStatus, presence, resetCall, sendCallEnd, updateCall])

  const acceptCall = useCallback(async () => {
    const current = callRef.current
    if (!current || current.phase !== 'incoming') return false
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      notifyRef.current('This browser does not support WebRTC calling.')
      return false
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: current.type === 'video' ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      })
      if (callRef.current?.callId !== current.callId) {
        stream.getTracks().forEach((track) => track.stop())
        return false
      }
      localStreamRef.current = stream
      setLocalStream(stream)
      setMicrophoneMuted(false)
      setCameraEnabled(current.type === 'video')
      createPeerConnection(current.callId, stream)
      updateCall(current.callId, { phase: 'connecting', connectionState: 'connecting' })
      const result = await emitWithAck(socketRef.current, 'call:accept', { callId: current.callId })
      if (!result.ok) {
        notifyRef.current(result.error || 'Could not accept the call.')
        resetCall()
        return false
      }
      return true
    } catch (error) {
      notifyRef.current(mediaErrorMessage(error, current.type))
      await emitWithAck(socketRef.current, 'call:reject', { callId: current.callId })
      resetCall()
      return false
    }
  }, [createPeerConnection, resetCall, updateCall])

  const rejectCall = useCallback(async () => {
    const current = callRef.current
    if (!current || current.phase !== 'incoming') return
    const request = emitWithAck(socketRef.current, 'call:reject', { callId: current.callId })
    resetCall()
    const result = await request
    if (!result.ok && result.code !== 'call_unavailable') notifyRef.current(result.error || 'Could not decline the call.')
  }, [resetCall])

  const cancelCall = useCallback(async () => {
    const current = callRef.current
    if (!current || current.phase !== 'outgoing') return
    const request = current.callId ? emitWithAck(socketRef.current, 'call:cancel', { callId: current.callId }) : null
    resetCall()
    if (request) {
      const result = await request
      if (!result.ok && result.code !== 'call_unavailable') notifyRef.current(result.error || 'Could not cancel the call.')
    }
  }, [resetCall])

  const endCall = useCallback(async () => {
    const current = callRef.current
    if (!current) return
    let request = null
    if (current.callId) {
      const eventName = current.phase === 'incoming' ? 'call:reject' : current.phase === 'outgoing' ? 'call:cancel' : 'call:end'
      request = emitWithAck(socketRef.current, eventName, { callId: current.callId })
    }
    resetCall()
    if (request) {
      const result = await request
      if (!result.ok && result.code !== 'call_unavailable') notifyRef.current(result.error || 'Could not end the call.')
    }
  }, [resetCall])

  const toggleMicrophone = useCallback(() => {
    const nextMuted = !microphoneMuted
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted })
    setMicrophoneMuted(nextMuted)
  }, [microphoneMuted])

  const toggleCamera = useCallback(() => {
    const nextEnabled = !cameraEnabled
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = nextEnabled })
    setCameraEnabled(nextEnabled)
  }, [cameraEnabled])

  const toggleSpeaker = useCallback(() => setSpeakerEnabled((enabled) => !enabled), [])
  const setBusy = useCallback(async (busy) => {
    const result = await emitWithAck(socketRef.current, 'presence:set_busy', { busy })
    if (result.ok && sessionRef.current?.user?.id) {
      setManualBusy(busy)
      setPresence((current) => ({ ...current, [sessionRef.current.user.id]: result.status }))
    }
    return result
  }, [])
  const canCall = useCallback((userId) => connectionStatus === 'connected' && presence[userId] === 'online' && !call && !blockedUserIds.includes(userId), [blockedUserIds, call, connectionStatus, presence])

  return {
    call,
    presence,
    connectionStatus,
    localStream,
    remoteStream,
    microphoneMuted,
    cameraEnabled,
    speakerEnabled,
    manualBusy,
    canCall,
    setBusy,
    startCall,
    acceptCall,
    rejectCall,
    cancelCall,
    endCall,
    toggleMicrophone,
    toggleCamera,
    toggleSpeaker,
  }
}
