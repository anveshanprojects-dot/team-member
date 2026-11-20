import 'dotenv/config'
import { createHmac, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CALL_ID_PATTERN = USER_ID_PATTERN
const MAX_SDP_LENGTH = 150_000
const MAX_ICE_CANDIDATE_LENGTH = 8_192

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseList(value, fallback = []) {
  if (!value) return fallback
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseOrigins(value) {
  return parseList(value, ['http://localhost:5173', 'http://127.0.0.1:5173']).map((origin) => {
    const url = new URL(origin)
    if (url.pathname !== '/' || url.search || url.hash) throw new Error(`Invalid frontend origin: ${origin}`)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported frontend origin: ${origin}`)
    return url.origin
  })
}

function parseIceUrls(value, fallback = []) {
  const urls = parseList(value, fallback)
  if (urls.some((url) => !/^(stun|stuns|turn|turns):/i.test(url))) {
    throw new Error('ICE server URLs must use the STUN, STUNS, TURN, or TURNS scheme.')
  }
  return urls
}

async function authenticateSupabase(accessToken) {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '')
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be configured on the signaling server.')

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) return null
  const user = await response.json()
  return typeof user?.id === 'string' && USER_ID_PATTERN.test(user.id) ? user : null
}

function safeDisplayName(value, fallback) {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned ? cleaned.slice(0, 80) : fallback
}

function safeAvatarUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function ackError(ack, code, message) {
  if (typeof ack === 'function') ack({ ok: false, code, error: message })
}

function ackSuccess(ack, result = {}) {
  if (typeof ack === 'function') ack({ ok: true, ...result })
}

export function createCallServer(options = {}) {
  const verifyToken = options.verifyToken || authenticateSupabase
  const frontendOrigins = options.frontendOrigins || parseOrigins(process.env.FRONTEND_ORIGINS)
  const stunUrls = options.stunUrls || parseIceUrls(process.env.STUN_URLS, ['stun:stun.l.google.com:19302'])
  const turnUrls = options.turnUrls || parseIceUrls(process.env.TURN_URLS)
  const turnSharedSecret = options.turnSharedSecret ?? process.env.TURN_SHARED_SECRET ?? ''
  const turnTtlSeconds = Number(options.turnTtlSeconds ?? process.env.TURN_CREDENTIAL_TTL_SECONDS ?? 3_600)
  const ringTimeoutMs = Number(options.ringTimeoutMs ?? process.env.CALL_RING_TIMEOUT_MS ?? 30_000)
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, service: 'anveshan-call-signaling', persistentCallStorage: false, turnConfigured: Boolean(turnUrls.length && turnSharedSecret) }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: 'Not found' }))
  })

  if (!Number.isInteger(turnTtlSeconds) || turnTtlSeconds < 60 || turnTtlSeconds > 86_400) {
    throw new Error('TURN_CREDENTIAL_TTL_SECONDS must be an integer between 60 and 86400.')
  }
  if (!Number.isInteger(ringTimeoutMs) || ringTimeoutMs < 5_000 || ringTimeoutMs > 120_000) {
    throw new Error('CALL_RING_TIMEOUT_MS must be an integer between 5000 and 120000.')
  }
  if (process.env.NODE_ENV === 'production' && frontendOrigins.some((origin) => origin.startsWith('http://'))) {
    throw new Error('Production FRONTEND_ORIGINS must use HTTPS.')
  }

  const io = new Server(server, {
    cors: {
      origin(origin, callback) {
        callback(null, !origin || frontendOrigins.includes(origin))
      },
      methods: ['GET', 'POST'],
    },
    allowRequest(request, callback) {
      const origin = request.headers.origin
      callback(null, !origin || frontendOrigins.includes(origin))
    },
    maxHttpBufferSize: 256 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  })

  const socketsByUser = new Map()
  const userBySocket = new Map()
  const calls = new Map()
  const activeCallByUser = new Map()
  const busyUsers = new Set()
  const inviteAttempts = new Map()

  function presenceOf(userId) {
    const sockets = socketsByUser.get(userId)
    if (!sockets?.size) return 'offline'
    const visible = [...sockets].some((socketId) => io.sockets.sockets.get(socketId)?.data.showOnlineStatus !== false)
    if (!visible) return 'offline'
    const call = calls.get(activeCallByUser.get(userId))
    if (call) return call.status === 'active' ? 'in_call' : 'busy'
    return busyUsers.has(userId) ? 'busy' : 'online'
  }

  function publishPresence(userId) {
    io.emit('presence:update', { userId, status: presenceOf(userId) })
  }

  function emitToUser(userId, event, payload, exceptSocketId = null) {
    for (const socketId of socketsByUser.get(userId) || []) {
      if (socketId !== exceptSocketId) io.to(socketId).emit(event, payload)
    }
  }

  function clearCall(call, eventForCaller, eventForCallee, reason, exceptSocketId = null) {
    if (call.timeout) clearTimeout(call.timeout)
    calls.delete(call.id)
    if (activeCallByUser.get(call.callerId) === call.id) activeCallByUser.delete(call.callerId)
    if (activeCallByUser.get(call.calleeId) === call.id) activeCallByUser.delete(call.calleeId)
    const payload = { callId: call.id, reason }
    if (eventForCaller) emitToUser(call.callerId, eventForCaller, payload, exceptSocketId)
    if (eventForCallee) emitToUser(call.calleeId, eventForCallee, payload, exceptSocketId)
    publishPresence(call.callerId)
    publishPresence(call.calleeId)
  }

  function participantPeer(call, socket) {
    const userId = socket.data.userId
    if (userId === call.callerId && socket.id === call.callerSocketId) {
      return call.calleeSocketId ? io.sockets.sockets.get(call.calleeSocketId) : null
    }
    if (userId === call.calleeId && socket.id === call.calleeSocketId) {
      return io.sockets.sockets.get(call.callerSocketId)
    }
    return null
  }

  function createIceConfiguration(userId) {
    const iceServers = stunUrls.length ? [{ urls: stunUrls }] : []
    let expiresAt = null
    if (turnUrls.length && turnSharedSecret) {
      expiresAt = Math.floor(Date.now() / 1_000) + turnTtlSeconds
      const username = `${expiresAt}:${userId}`
      const credential = createHmac('sha1', turnSharedSecret).update(username).digest('base64')
      iceServers.push({ urls: turnUrls, username, credential })
    }
    return { iceServers, expiresAt }
  }

  io.use(async (socket, next) => {
    const accessToken = socket.handshake.auth?.accessToken
    if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 8_192) {
      next(new Error('Authentication required.'))
      return
    }
    try {
      const user = await verifyToken(accessToken)
      if (!user?.id || !USER_ID_PATTERN.test(user.id)) {
        next(new Error('Authentication failed.'))
        return
      }
      socket.data.userId = user.id
      socket.data.showOnlineStatus = socket.handshake.auth?.showOnlineStatus !== false
      socket.data.displayName = safeDisplayName(
        user.user_metadata?.full_name || user.user_metadata?.name,
        'Anveshan member',
      )
      next()
    } catch (error) {
      next(new Error(error.message || 'Authentication service is unavailable.'))
    }
  })

  io.on('connection', (socket) => {
    const userId = socket.data.userId
    const existing = socketsByUser.get(userId) || new Set()
    const becameOnline = existing.size === 0
    existing.add(socket.id)
    socketsByUser.set(userId, existing)
    userBySocket.set(socket.id, userId)
    socket.emit('presence:snapshot', [...socketsByUser.keys()]
      .map((id) => ({ userId: id, status: presenceOf(id) }))
      .filter((entry) => entry.status !== 'offline'))
    socket.emit('webrtc:config', createIceConfiguration(userId))
    if (becameOnline) publishPresence(userId)

    socket.on('presence:set_busy', (payload, ack) => {
      if (!isRecord(payload) || typeof payload.busy !== 'boolean') {
        ackError(ack, 'invalid_payload', 'Busy status must be true or false.')
        return
      }
      if (payload.busy) busyUsers.add(userId)
      else busyUsers.delete(userId)
      publishPresence(userId)
      ackSuccess(ack, { status: presenceOf(userId) })
    })

    socket.on('presence:set_visibility', (payload, ack) => {
      if (!isRecord(payload) || typeof payload.visible !== 'boolean') {
        ackError(ack, 'invalid_payload', 'Online visibility must be true or false.')
        return
      }
      socket.data.showOnlineStatus = payload.visible
      publishPresence(userId)
      ackSuccess(ack, { status: presenceOf(userId) })
    })

    socket.on('call:invite', (payload, ack) => {
      if (!isRecord(payload) || !USER_ID_PATTERN.test(payload.toUserId || '') || !['audio', 'video'].includes(payload.callType)) {
        ackError(ack, 'invalid_payload', 'Choose a valid team member and call type.')
        return
      }
      const calleeId = payload.toUserId
      if (calleeId === userId) {
        ackError(ack, 'self_call', 'You cannot call yourself.')
        return
      }
      const attemptTimes = (inviteAttempts.get(userId) || []).filter((time) => Date.now() - time < 60_000)
      if (attemptTimes.length >= 10) {
        ackError(ack, 'rate_limited', 'Too many calls. Please wait a minute and try again.')
        return
      }
      attemptTimes.push(Date.now())
      inviteAttempts.set(userId, attemptTimes)
      if (activeCallByUser.has(userId)) {
        ackError(ack, 'busy', 'You are already in a call.')
        return
      }
      const calleeSockets = socketsByUser.get(calleeId)
      if (!calleeSockets?.size) {
        ackError(ack, 'offline', 'This person is offline.')
        return
      }
      if (activeCallByUser.has(calleeId) || busyUsers.has(calleeId)) {
        ackError(ack, 'busy', 'This person is busy.')
        return
      }
      const callerProfile = isRecord(payload.callerProfile) ? payload.callerProfile : {}
      const call = {
        id: randomUUID(),
        callerId: userId,
        calleeId,
        callerSocketId: socket.id,
        calleeSocketId: null,
        type: payload.callType,
        status: 'ringing',
        timeout: null,
      }
      calls.set(call.id, call)
      activeCallByUser.set(userId, call.id)
      activeCallByUser.set(calleeId, call.id)
      ackSuccess(ack, { callId: call.id })
      emitToUser(calleeId, 'call:incoming', {
        callId: call.id,
        caller: {
          userId,
          name: safeDisplayName(callerProfile.name, socket.data.displayName),
          avatarUrl: safeAvatarUrl(callerProfile.avatarUrl),
        },
        callType: call.type,
      })
      publishPresence(userId)
      publishPresence(calleeId)
      call.timeout = setTimeout(() => {
        if (calls.get(call.id) === call && call.status === 'ringing') {
          clearCall(call, 'call:timeout', 'call:missed', 'no_answer')
        }
      }, ringTimeoutMs)
      call.timeout.unref?.()
    })

    socket.on('call:accept', (payload, ack) => {
      if (!isRecord(payload) || !CALL_ID_PATTERN.test(payload.callId || '')) {
        ackError(ack, 'invalid_payload', 'A valid call ID is required.')
        return
      }
      const call = calls.get(payload.callId)
      if (!call || call.calleeId !== userId || call.status !== 'ringing') {
        ackError(ack, 'call_unavailable', 'This call is no longer available.')
        return
      }
      if (!io.sockets.sockets.has(call.callerSocketId)) {
        clearCall(call, null, 'call:ended', 'disconnected')
        ackError(ack, 'caller_disconnected', 'The caller disconnected.')
        return
      }
      if (call.timeout) clearTimeout(call.timeout)
      call.timeout = null
      call.status = 'active'
      call.calleeSocketId = socket.id
      io.to(call.callerSocketId).emit('call:accepted', { callId: call.id })
      emitToUser(call.calleeId, 'call:accepted_elsewhere', { callId: call.id }, socket.id)
      publishPresence(call.callerId)
      publishPresence(call.calleeId)
      ackSuccess(ack)
    })

    socket.on('call:reject', (payload, ack) => {
      if (!isRecord(payload) || !CALL_ID_PATTERN.test(payload.callId || '')) {
        ackError(ack, 'invalid_payload', 'A valid call ID is required.')
        return
      }
      const call = calls.get(payload.callId)
      if (!call || call.calleeId !== userId || call.status !== 'ringing') {
        ackError(ack, 'call_unavailable', 'This call is no longer available.')
        return
      }
      ackSuccess(ack)
      clearCall(call, 'call:rejected', 'call:ended', 'rejected', socket.id)
    })

    socket.on('call:cancel', (payload, ack) => {
      if (!isRecord(payload) || !CALL_ID_PATTERN.test(payload.callId || '')) {
        ackError(ack, 'invalid_payload', 'A valid call ID is required.')
        return
      }
      const call = calls.get(payload.callId)
      if (!call || call.callerId !== userId || call.status !== 'ringing') {
        ackError(ack, 'call_unavailable', 'This call can no longer be cancelled.')
        return
      }
      ackSuccess(ack)
      clearCall(call, 'call:ended', 'call:cancelled', 'cancelled', socket.id)
    })

    socket.on('call:end', (payload, ack) => {
      if (!isRecord(payload) || !CALL_ID_PATTERN.test(payload.callId || '')) {
        ackError(ack, 'invalid_payload', 'A valid call ID is required.')
        return
      }
      const call = calls.get(payload.callId)
      if (!call || ![call.callerId, call.calleeId].includes(userId) || call.status !== 'active') {
        ackError(ack, 'call_unavailable', 'This call is no longer active.')
        return
      }
      const peerEvent = userId === call.callerId ? 'call:ended' : 'call:ended'
      ackSuccess(ack)
      clearCall(call, peerEvent, peerEvent, 'ended', socket.id)
    })

    socket.on('webrtc:offer', (payload, ack) => relayDescription(socket, payload, ack, 'offer', 'webrtc:offer'))
    socket.on('webrtc:answer', (payload, ack) => relayDescription(socket, payload, ack, 'answer', 'webrtc:answer'))
    socket.on('webrtc:ice', (payload, ack) => relayIceCandidate(socket, payload, ack))

    socket.on('disconnect', () => {
      const sockets = socketsByUser.get(userId)
      sockets?.delete(socket.id)
      userBySocket.delete(socket.id)
      if (sockets?.size === 0) {
        socketsByUser.delete(userId)
        busyUsers.delete(userId)
      }
      const call = calls.get(activeCallByUser.get(userId))
      if (call && (call.callerSocketId === socket.id || call.calleeSocketId === socket.id || !socketsByUser.has(userId))) {
        clearCall(call, 'call:ended', 'call:ended', 'disconnected', socket.id)
      }
      if (!socketsByUser.has(userId)) publishPresence(userId)
      for (const [id, attempts] of inviteAttempts) {
        if (!socketsByUser.has(id)) inviteAttempts.delete(id)
        else if (!attempts.length) inviteAttempts.delete(id)
      }
    })
  })

  function relayDescription(socket, payload, ack, expectedType, eventName) {
    if (!isRecord(payload) || !CALL_ID_PATTERN.test(payload.callId || '') || !isRecord(payload.description) ||
      payload.description.type !== expectedType || typeof payload.description.sdp !== 'string' ||
      !payload.description.sdp.length || payload.description.sdp.length > MAX_SDP_LENGTH) {
      ackError(ack, 'invalid_payload', 'The WebRTC description is invalid.')
      return
    }
    const call = calls.get(payload.callId)
    const peer = call?.status === 'active' ? participantPeer(call, socket) : null
    if (!peer) {
      ackError(ack, 'unauthorized', 'You are not an active participant in this call.')
      return
    }
    peer.emit(eventName, { callId: call.id, description: payload.description })
    ackSuccess(ack)
  }

  function relayIceCandidate(socket, payload, ack) {
    if (!isRecord(payload) || !CALL_ID_PATTERN.test(payload.callId || '') || !isRecord(payload.candidate) ||
      typeof payload.candidate.candidate !== 'string' || !payload.candidate.candidate.length ||
      payload.candidate.candidate.length > MAX_ICE_CANDIDATE_LENGTH ||
      (payload.candidate.sdpMid != null && (typeof payload.candidate.sdpMid !== 'string' || payload.candidate.sdpMid.length > 256)) ||
      (payload.candidate.usernameFragment != null && (typeof payload.candidate.usernameFragment !== 'string' || payload.candidate.usernameFragment.length > 256)) ||
      (payload.candidate.sdpMLineIndex != null && (!Number.isInteger(payload.candidate.sdpMLineIndex) || payload.candidate.sdpMLineIndex < 0 || payload.candidate.sdpMLineIndex > 65_535))) {
      ackError(ack, 'invalid_payload', 'The ICE candidate is invalid.')
      return
    }
    const call = calls.get(payload.callId)
    const peer = call?.status === 'active' ? participantPeer(call, socket) : null
    if (!peer) {
      ackError(ack, 'unauthorized', 'You are not an active participant in this call.')
      return
    }
    peer.emit('webrtc:ice', { callId: call.id, candidate: payload.candidate })
    ackSuccess(ack)
  }

  return {
    httpServer: server,
    io,
    state: { socketsByUser, calls, activeCallByUser, busyUsers },
  }
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirectExecution) {
  const port = Number(process.env.PORT || 3_001)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port.')
  const { httpServer } = createCallServer()
  httpServer.listen(port, '0.0.0.0', () => {
    console.info(`Anveshan call signaling listening on port ${port}.`)
  })
}
