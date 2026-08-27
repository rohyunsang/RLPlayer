import net from 'node:net'
import { EventEmitter } from 'node:events'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Speaks mpv's JSON IPC protocol over a Windows named pipe.
 *
 * Protocol is one JSON object per line, in both directions:
 *   -> {"command":["get_property","time-pos"],"request_id":7}
 *   <- {"error":"success","data":12.34,"request_id":7}
 *   <- {"event":"property-change","id":3,"name":"pause","data":true}
 *
 * Replies are correlated by request_id; events are re-emitted on this emitter.
 */
export class MpvClient extends EventEmitter {
  private socket: net.Socket | null = null
  private buffer = ''
  private nextRequestId = 1
  private nextObserveId = 1
  private readonly pending = new Map<number, Pending>()
  private closed = false

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  /**
   * mpv creates the pipe a moment after spawn, so connecting races startup.
   * Retry on a short interval rather than failing the first attempt.
   */
  async connect(pipePath: string, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.closed) throw new Error('client closed while connecting')
      try {
        await this.tryConnect(pipePath)
        return
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(
            `could not connect to mpv IPC at ${pipePath}: ${(err as Error).message}`
          )
        }
        await new Promise((r) => setTimeout(r, 120))
      }
    }
  }

  private tryConnect(pipePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ path: pipePath })
      const onError = (e: Error): void => {
        sock.destroy()
        reject(e)
      }
      sock.once('error', onError)
      sock.once('connect', () => {
        sock.off('error', onError)
        sock.setEncoding('utf8')
        this.socket = sock
        sock.on('data', (chunk: string) => this.onData(chunk))
        sock.on('close', () => {
          this.socket = null
          this.failAllPending(new Error('mpv IPC closed'))
          this.emit('disconnected')
        })
        sock.on('error', (e) => this.emit('ipc-error', e))
        resolve()
      })
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx = this.buffer.indexOf('\n')
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line) {
        try {
          this.dispatch(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // mpv can emit non-JSON noise on the pipe; ignore that line.
        }
      }
      idx = this.buffer.indexOf('\n')
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.request_id === 'number') {
      const p = this.pending.get(msg.request_id)
      if (p) {
        this.pending.delete(msg.request_id)
        clearTimeout(p.timer)
        if (msg.error === 'success') p.resolve(msg.data)
        else p.reject(new Error(String(msg.error ?? 'unknown mpv error')))
      }
      return
    }
    const event = msg.event
    if (typeof event !== 'string') return
    if (event === 'property-change') {
      this.emit('property-change', msg.name as string, msg.data)
    }
    this.emit('mpv-event', event, msg)
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /** Send a raw mpv command array and await its reply. */
  command<T = unknown>(args: unknown[], timeoutMs = 8000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('mpv IPC not connected'))
        return
      }
      const id = this.nextRequestId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mpv command timed out: ${JSON.stringify(args)}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.socket.write(JSON.stringify({ command: args, request_id: id }) + '\n')
    })
  }

  /** Fire-and-forget, for high-frequency traffic like drag-scrub seeks. */
  commandNoReply(args: unknown[]): void {
    if (!this.socket || this.socket.destroyed) return
    this.socket.write(JSON.stringify({ command: args }) + '\n')
  }

  getProperty<T = unknown>(name: string): Promise<T> {
    return this.command<T>(['get_property', name])
  }

  async setProperty(name: string, value: unknown): Promise<void> {
    await this.command(['set_property', name, value])
  }

  /** Ask mpv to push changes for `name`; they arrive as 'property-change'. */
  async observeProperty(name: string): Promise<void> {
    const id = this.nextObserveId++
    await this.command(['observe_property', id, name])
  }

  close(): void {
    this.closed = true
    this.failAllPending(new Error('client closed'))
    this.socket?.destroy()
    this.socket = null
  }
}
