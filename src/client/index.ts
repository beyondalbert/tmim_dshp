/**
 * TM IM settings page — browser half.
 *
 * Registers a centered main panel plus its left-sidebar entry (the same
 * pattern as the built-in Automation Tasks panel), so the settings page is
 * reachable from the sidebar directly. The page reads/writes the plugin's own
 * config (persisted into the profile's `cordis.patch.yml` and hot-reloaded by
 * the Host's configEditor, so saves here take effect on the running bridge
 * without a restart).
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { TmimCard } from './TmimCard.tsx'
import { TmimIcon } from './TmimIcon.tsx'
import { TmimCardController, TMIM_NS } from './tmim-card-controller.ts'
import { en, zh, type TmimLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** TM IM settings page copy. */
    'settings.tmim': TmimLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.tmim'

/** Settings namespace the Host serves for this plugin. */
export const ROW_ID = TMIM_NS

/** Central panel id; shared by the sidebar entry and the main-slot occupant. */
export const PANEL_ID = 'tmim' as MainPanelId

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the TM IM settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tmim-client: dictionaries')
  const controller = new TmimCardController(ctx)
  ctx.effect(() => () => { controller.dispose() }, 'tmim-client: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([TMIM_NS], () => {
    const stopPage = ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PANEL_ID, locale: NS,
      inject: () => controller.inject(),
    }, TmimCard))
    const stopSidebar = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: 120,
      locale: NS, label: () => t('panel'),
    }, TmimIcon))
    return () => { stopSidebar(); stopPage() }
  }), 'tmim-client: page')
}
