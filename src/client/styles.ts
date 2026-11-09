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
  padding: 8px 8px 24px 20px;
  scrollbar-gutter: stable;
}
.dshTmSection {
  margin: 0 0 20px 0;
  padding-bottom: 2px;
}
.dshTmSection + .dshTmSection {
  border-top: 1px solid var(--dsw-alias-divider-1, rgba(28,31,35,0.08));
  padding-top: 18px;
}
.dshTmSectionCompact {
  border-top: 0 !important;
  padding-top: 0;
  margin-bottom: 12px;
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
.dshTmBool {
  grid-template-columns: minmax(0, 1fr);
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
.dshTmReadonly {
  min-height: 32px;
  padding: 5px 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #646a73);
  overflow-wrap: anywhere;
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
.dshTmAdvanced {
  margin: 4px 0 20px 0;
  border: 1px solid var(--dsw-alias-divider-1, rgba(28,31,35,0.08));
  border-radius: 8px;
  overflow: hidden;
}
.dshTmAdvanced [data-disclosure-header] {
  min-height: 40px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.dshTmAdvancedDot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #3370ff);
}
.dshTmAdvancedBody {
  padding: 12px 14px 4px;
}
.dshTmSectionSeparator .dshTmSection:first-child,
.dshTmSectionSeparator > .dshTmSection:not(:first-child) {
  padding-top: 0;
  border-top: 0;
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
