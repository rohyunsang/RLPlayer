import './playlist.css'
import type { RendererFeatureModule } from '../../../../shared/renderer-api.ts'
import type { PlaylistState } from '../../../../shared/types.ts'

/**
 * M28 playlist, renderer half.
 *
 * WAVE 0 SEED, and the PROOF that `ctx.panel()` is a real contribution point
 * rather than an array nothing reads. The queue panel — its markup, its CSS,
 * its drag-reorder, its shuffle/repeat controls — lives entirely in this
 * directory. Before this it was `<aside id="playlist">` in the shared
 * `index.html`, `renderPlaylist()` in the shared `main.ts` and 150 lines in the
 * shared `styles.css`, which is exactly the M28 / M21 collision the audit
 * measured: M21's subtitle browser wants a right-hand panel too, and there was
 * only one `#playlist` host to fight over.
 *
 * Note the ownership rule holding on both halves: nothing here writes an mpv
 * property or reaches into core's chrome. It sends on its own channels, and its
 * main half owns the queue.
 */

const svg = (d: string): SVGSVGElement => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  s.setAttribute('viewBox', '0 0 16 16')
  s.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', d)
  s.appendChild(p)
  return s
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const mod: RendererFeatureModule = {
  id: 'playlist',

  setup(ctx): void {
    // The settings window runs the same glob; a queue panel has no business
    // there, and building its DOM would be wasted work.
    if (ctx.surface !== 'player') return

    let state: PlaylistState = {
      items: [],
      index: -1,
      open: false,
      repeat: 'off',
      shuffle: false
    }
    let dragFrom = -1

    ctx.panel({
      id: 'playlist',
      side: 'right',
      titleKey: 'playlist.title',
      order: 10,
      mount(host): () => void {
        const head = el('div', 'pl-head')
        const h2 = el('h2', undefined, ctx.t('playlist.title'))
        const count = el('span', 'pl-count')
        h2.appendChild(count)
        head.appendChild(h2)

        const tools = el('div', 'pl-tools')
        const shuffleBtn = el('button', 'icon-btn small')
        shuffleBtn.type = 'button'
        shuffleBtn.title = ctx.t('playlist.shuffle')
        shuffleBtn.setAttribute('aria-label', ctx.t('playlist.shuffle'))
        shuffleBtn.appendChild(svg('M2 4h3l6 8h3M2 12h3l6-8h3M12 2l2 2-2 2M12 10l2 2-2 2'))

        const repeatBtn = el('button', 'icon-btn small')
        repeatBtn.type = 'button'
        repeatBtn.title = ctx.t('playlist.repeat')
        repeatBtn.setAttribute('aria-label', ctx.t('playlist.repeat'))
        repeatBtn.appendChild(svg('M3 6a3 3 0 013-3h7M13 10a3 3 0 01-3 3H3M11 1l2 2-2 2M5 11l-2 2 2 2'))
        const repeatBadge = el('span', 'pl-badge', '1')
        repeatBadge.hidden = true
        repeatBtn.appendChild(repeatBadge)

        const closeBtn = el('button', 'icon-btn small')
        closeBtn.type = 'button'
        closeBtn.setAttribute('aria-label', ctx.t('playlist.close'))
        closeBtn.appendChild(svg('M4 4l8 8M12 4l-8 8'))

        tools.append(shuffleBtn, repeatBtn, closeBtn)
        head.appendChild(tools)

        const items = el('ol', 'pl-items')
        host.append(head, items)

        shuffleBtn.addEventListener('click', () =>
          ctx.ipc.send('playlist:setShuffle', !state.shuffle)
        )
        repeatBtn.addEventListener('click', () => {
          const order = ['off', 'one', 'all'] as const
          const next = order[(order.indexOf(state.repeat) + 1) % order.length]!
          ctx.ipc.send('playlist:setRepeat', next)
          ctx.osd.show({ kind: 'info', text: ctx.t(`playlist.repeat.${next}`) })
        })
        closeBtn.addEventListener('click', () => ctx.ipc.send('playlist:togglePanel'))

        // Drag reorder, delegated: the rows are rebuilt on every push.
        items.addEventListener('dragstart', (e) => {
          const li = (e.target as HTMLElement).closest<HTMLElement>('.pl-item')
          if (!li) return
          dragFrom = Number(li.dataset['index'])
          li.classList.add('dragging')
          e.dataTransfer?.setData('text/plain', String(dragFrom))
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
        })
        items.addEventListener('dragover', (e) => {
          e.preventDefault()
          const li = (e.target as HTMLElement).closest<HTMLElement>('.pl-item')
          for (const n of items.querySelectorAll('.drag-over')) n.classList.remove('drag-over')
          li?.classList.add('drag-over')
        })
        items.addEventListener('drop', (e) => {
          e.preventDefault()
          // The window-level file-drop handler must not also fire.
          e.stopPropagation()
          const li = (e.target as HTMLElement).closest<HTMLElement>('.pl-item')
          for (const n of items.querySelectorAll('.drag-over')) n.classList.remove('drag-over')
          if (!li || dragFrom < 0) return
          const to = Number(li.dataset['index'])
          if (to !== dragFrom) ctx.ipc.send('playlist:reorder', { from: dragFrom, to })
          dragFrom = -1
        })
        items.addEventListener('dragend', () => {
          for (const n of items.querySelectorAll('.dragging')) n.classList.remove('dragging')
          dragFrom = -1
        })

        function render(p: PlaylistState): void {
          state = p
          host.hidden = !p.open
          shuffleBtn.setAttribute('aria-pressed', String(p.shuffle))
          repeatBtn.setAttribute('aria-pressed', String(p.repeat !== 'off'))
          repeatBadge.hidden = p.repeat !== 'one'
          count.textContent = p.items.length ? `${p.index + 1}/${p.items.length}` : ''

          items.textContent = ''
          p.items.forEach((item, i) => {
            const li = el('li', 'pl-item' + (i === p.index ? ' current' : ''))
            li.tabIndex = 0
            li.draggable = true
            li.dataset['index'] = String(i)
            li.setAttribute('role', 'button')
            // textContent, never innerHTML: this string is a filesystem path.
            const name = el('span', 'pl-name', item.name)
            name.title = item.name
            li.appendChild(name)

            const rm = el('button', 'pl-remove')
            rm.type = 'button'
            rm.setAttribute('aria-label', ctx.t('playlist.remove', { name: item.name }))
            rm.appendChild(svg('M4 4l8 8M12 4l-8 8'))
            rm.addEventListener('click', (e) => {
              e.stopPropagation()
              ctx.ipc.send('playlist:remove', i)
            })
            li.appendChild(rm)

            li.addEventListener('click', () => ctx.ipc.send('playlist:play', i))
            li.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                ctx.ipc.send('playlist:play', i)
              }
            })
            items.appendChild(li)
          })
          items.children[p.index]?.scrollIntoView({ block: 'nearest' })
        }

        const off = ctx.ipc.on<PlaylistState>('playlist:state', render)
        // Main pushes on open/change; ask once so a panel mounted after the
        // last push is not empty.
        ctx.ipc.send('playlist:request')
        return () => off()
      }
    })
  }
}

export default mod
