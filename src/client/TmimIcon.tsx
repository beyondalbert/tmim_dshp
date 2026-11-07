/**
 * TM IM sidebar glyph.
 *
 * Renders a small chat-bubble glyph as the direct icon child of the sidebar
 * panel row. The sidebar owns the button, accessible label and selected state;
 * this component only draws the mark at the requested edge size.
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'

/** Rendered props for the sidebar's TM IM entry. */
export type TmimIconProps = PropsRuntime<'sidebar.panellist'>

/** Draw a minimal IM chat bubble at the sidebar-requested edge. */
export function TmimIcon({ size }: TmimIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      role="presentation" aria-hidden="true">
      <path d="M4 11.5A6.5 6.5 0 0 1 10.5 5h3A6.5 6.5 0 0 1 20 11.5v2.25a2.25 2.25 0 0 1-2.25 2.25H12l-4.5 3v-3.05A6.5 6.5 0 0 1 4 13.75z"
        fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <circle cx="9" cy="12.5" r="0.9" fill="currentColor" />
      <circle cx="12" cy="12.5" r="0.9" fill="currentColor" />
      <circle cx="15" cy="12.5" r="0.9" fill="currentColor" />
    </svg>
  )
}
