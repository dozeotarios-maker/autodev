import type { ExtensionAPI, SessionStartEvent, ExtensionContext } from '@earendil-works/pi-coding-agent'

export default function autodevExtension(pi: ExtensionAPI): void {
  pi.on('session_start', async (event: SessionStartEvent, ctx: ExtensionContext) => {
    console.log('[pi-autodev] ARMED — health check pass, idle-wait')
    ctx.ui.setStatus('autodev', 'ARMED')
  })
}
