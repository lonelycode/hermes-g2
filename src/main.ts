import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Controller } from './app/controller.ts'
import { loadSettings, makeSettingsStore, saveSettings, type Settings } from './config.ts'
import { Glasses } from './glasses/display.ts'
import { gestureFrom } from './glasses/input.ts'
import { mountCompanion } from './ui/companion.ts'

const READY_MARKER = '[hermes-g2] ready'

async function bridgeOrNull(timeoutMs: number): Promise<EvenAppBridge | null> {
  return Promise.race([
    waitForEvenAppBridge().catch(() => null),
    new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

async function main(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app')!
  const bridge = await bridgeOrNull(6000)
  const store = makeSettingsStore(bridge ?? undefined)
  let settings: Settings = await loadSettings(store)
  if (import.meta.env.DEV) {
    // ?scroll=smooth|page lets simulator runs try a scroll mode without touching stored settings.
    const q = new URLSearchParams(location.search)
    const scroll = q.get('scroll')
    if (scroll === 'smooth' || scroll === 'page') settings = { ...settings, scrollMode: scroll }
    const turn = q.get('turn')
    if (turn === 'none' || turn === 'slide' || turn === 'fade' || turn === 'blink') settings = { ...settings, pageTransition: turn }
  }

  let controller: Controller | null = null
  const companion = mountCompanion(root, settings, {
    async onSave(next) {
      settings = next
      await saveSettings(store, next)
      await controller?.applySettings(next)
    },
    async onSend(text) {
      if (!controller) throw new Error('no glasses bridge')
      await controller.submitText(text)
    },
  })

  if (!bridge) {
    companion.setBridgeState('not available (open inside the Even app or the simulator)')
    companion.log('No Even bridge — running companion UI only.')
    return
  }
  companion.setBridgeState('ready')

  const glasses = new Glasses(bridge, { onMirror: (layout, c) => companion.setMirror(layout, c) })
  controller = new Controller({
    bridge,
    glasses,
    settings,
    log: line => companion.log(line),
    onSnapshot: snap => companion.setSnapshot(snap),
  })

  // One subscription for everything the OS pushes: input gestures, audio frames, lifecycle.
  const unsubscribe = bridge.onEvenHubEvent(event => {
    const pcm = event.audioEvent?.audioPcm
    if (pcm) {
      controller?.handleAudio(pcm)
      return
    }
    const gesture = gestureFrom(event)
    if (!gesture) return
    if (gesture.kind !== 'fg_enter' && gesture.kind !== 'fg_exit') {
      companion.log(`gesture ${gesture.kind}${gesture.listIndex !== undefined ? ` #${gesture.listIndex}` : ''}${gesture.menuItemId ? ` menu ${gesture.menuItemId}` : ''} (${gesture.source})`)
    }
    controller?.handleGesture(gesture).catch(err => companion.log(`gesture failed: ${(err as Error).message}`))
  })

  bridge.onLaunchSource(source => companion.log(`launched from ${source}`))

  const cleanup = () => {
    unsubscribe()
    void controller?.stop()
  }
  window.addEventListener('beforeunload', cleanup)
  window.addEventListener('pagehide', cleanup)
  // Vite full reloads: release the mic and event streams before the new page boots.
  import.meta.hot?.dispose(cleanup)

  await controller.start()
  console.log(READY_MARKER)

  // Dev-only scripted input for headless simulator runs: ?say=hello%7Capprove%20this&gap=8000
  if (import.meta.env.DEV) {
    const params = new URLSearchParams(location.search)
    const say = params.get('say')
    if (say) {
      const gap = Number(params.get('gap') || 8000)
      const c = controller
      let delay = 1500
      for (const text of say.split(/[|;]/)) {
        setTimeout(() => void c.submitText(text), delay)
        delay += gap
      }
    }
  }
}

main().catch(err => {
  console.error(`[hermes-g2] fatal: ${(err as Error)?.message ?? err}`)
  const root = document.querySelector<HTMLDivElement>('#app')
  if (root) root.textContent = `Fatal: ${(err as Error).message}`
})
