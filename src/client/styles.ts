/**
 * Injected CSS for the TM IM settings page.
 *
 * The DSH main panel hosts our component in a content area that is itself the
 * scroll container, so the page becomes scrollable when we give our root a
 * bounded height + `overflow: auto`. We also style the day-to-day form rows
 * (labels, controls, hints, sections) so the page looks like the rest of DSH
 * rather than relying on the host theme alone.
 */

export const TMIM_STYLE_ID = '@tmim/dsh-plugin-tmim'

const CSS = `
.dshTmPage {
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  padding: 4px 2px 24px 2px;
  scrollbar-gutter: stable;
}
.dshTmSection {
  margin: 0 0 20px 0;
  padding-bottom: 16px;
}
.dshTmSection + .dshTmSection {
  border-top: 1px solid var(--dsw-alias-divider-1, rgba(28,31,35,0.08));
  padding-top: 18px;
}
.dshTmSectionTitle {
  margin: 0 0 12px 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.dshTmRow {
  display: grid;
  grid-template-columns: minmax(0, 180px) minmax(0, 1fr);
  align-items: start;
  gap: 8px 16px;
  margin-bottom: 14px;
}
.dshTmRow > label.dshTmLbl {
  padding-top: 6px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1f2329);
  overflow-wrap: anywhere;
}
.dshTmCtl {
  min-width: 0;
  display: grid;
  gap: 6px;
}
.dshTmCtl > input,
.dshTmCtl > .dshTmInput {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
.dshTmHint,
.dshTmErr {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dshTmHint {
  color: var(--dsw-alias-label-secondary, #646a73);
}
.dshTmErr {
  color: var(--dsw-alias-alert-warning, #d54941);
}
@media (max-width: 560px) {
  .dshTmRow { grid-template-columns: minmax(0, 1fr); }
}
`

export function installTmimStyles() {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${TMIM_STYLE_ID}"]`)
  if (existing) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = TMIM_STYLE_ID
  style.dataset.pluginCss = TMIM_STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}
