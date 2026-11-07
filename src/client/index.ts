/**
 * TM IM settings page — browser half.
 *
 * Registers the plugin's configuration page into the Plugins page's
 * `plugins.item` slot while the Host serves the `tmim` settings namespace.
 * The page reads/writes the plugin's own config (persisted into the profile's
 * `cordis.patch.yml` and hot-reloaded by the Host's configEditor, so saves
 * here take effect on the running bridge without a restart).
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { TmimCard } from './TmimCard.tsx'
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

/** Plugin row id in the Host composition. */
export const ROW_ID = TMIM_NS

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the TM IM settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tmim-client: dictionaries')
  const card = new TmimCardController(ctx)
  ctx.effect(() => () => { card.dispose() }, 'tmim-client: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([TMIM_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'tmim', order: 110, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, TmimCard))), 'tmim-client: page')
}
