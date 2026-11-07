import {
  SettingsForm,
  Checkbox,
  Input,
  SegmentedControl,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TmimCardFace, TmimCardView } from './tmim-card-controller.ts'
import type { TmimLocaleKey } from './locales.ts'

/** Rendered props for the TM IM settings entry. */
export type TmimCardProps =
  PropsLocale<'settings.tmim'>
  & PropsRuntime<'main'>
  & InjectFace<TmimCardFace>

function TextRow(props: {
  id: string; label: string; hint?: string; value: string; disabled: boolean
  secret?: boolean; onChange: (v: string) => void
}) {
  return (
    <div className="dshTmRow">
      <label className="dshTmLbl" htmlFor={props.id}>{props.label}</label>
      <div className="dshTmCtl">
        <Input id={props.id} type={props.secret ? 'password' : 'text'}
          autoComplete={props.secret ? 'new-password' : undefined}
          value={props.value} disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)} />
        {props.hint ? <p className="dshTmHint">{props.hint}</p> : null}
      </div>
    </div>
  )
}

function NumberRow(props: {
  id: string; label: string; hint?: string; value: string; disabled: boolean
  invalid?: boolean; onChange: (v: string) => void
}) {
  return (
    <div className="dshTmRow">
      <label className="dshTmLbl" htmlFor={props.id}>{props.label}</label>
      <div className="dshTmCtl">
        <Input id={props.id} type="number" value={props.value} disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)} />
        {props.invalid ? <p className="dshTmErr">{props.hint}</p> : props.hint ? <p className="dshTmHint">{props.hint}</p> : null}
      </div>
    </div>
  )
}

function BoolRow(props: {
  id: string; label: string; hint?: string; checked: boolean; disabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="dshTmRow">
      <div className="dshTmCtl">
        <Checkbox checked={props.checked} label={props.label}
          disabled={props.disabled} onChange={props.onChange} />
        {props.hint ? <p className="dshTmHint">{props.hint}</p> : null}
      </div>
    </div>
  )
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="dshTmSection">
      <h3 className="dshTmSectionTitle">{props.title}</h3>
      {props.children}
    </section>
  )
}

/**
 * The TM IM settings page: connection, credential, inbound delivery, agent,
 * and advanced fields, staged through the injected controller and saved as
 * one atomic, revision-fenced mutation.
 */
export function TmimCard(props: TmimCardProps) {
  const t = props.t
  const view = props.useTmim((s: TmimCardView) => s)
  const key = (k: TmimLocaleKey): string => t(k as never)

  const v = view.value
  const disabled = !view.writable

  return (
    <SettingsForm
      labels={{
        unavailable: key('unavailable'),
        readOnly: key('readOnly'),
        save: key('save'),
        saving: key('saving'),
        saveFailed: key('saveFailed'),
      }}
      state={view}
      onSave={props.save}
      onDiscard={() => {}}
    >
      {v === undefined ? null : (
        <>
          <Section title={key('sectionConnection')}>
            <TextRow id="tmim-baseUrl" label={key('baseUrl')} hint={key('baseUrlHint')}
              value={props.text('baseUrl')} disabled={disabled}
              onChange={(x) => props.editText('baseUrl', x)} />
            <TextRow id="tmim-deviceId" label={key('deviceId')} hint={key('deviceIdHint')}
              value={props.text('deviceId')} disabled={disabled}
              onChange={(x) => props.editText('deviceId', x)} />
          </Section>

          <Section title={key('sectionCredential')}>
            <p className="dshTmHint">{key('credentialHint')}</p>
            <div className="dshTmRow">
              <div className="dshTmCtl">
                <SegmentedControl
                  id="tmim-credKind"
                  label={key('sectionCredential')}
                  value={v.credential?.kind ?? 'apikey'}
                  options={[
                    { value: 'apikey', label: key('credKindApikey') },
                    { value: 'password', label: key('credKindPassword') },
                  ]}
                  disabled={disabled}
                  onChange={(k) => props.setCredentialKind(k as 'apikey' | 'password')}
                />
              </div>
            </div>
            {v.credential?.kind === 'password' ? (
              <>
                <TextRow id="tmim-credUser" label={key('credUsername')}
                  value={props.text('credential.username')} disabled={disabled}
                  onChange={(x) => props.editText('credential.username', x)} />
                <TextRow id="tmim-credPass" label={key('credPassword')} secret
                  value={props.text('credential.password')} disabled={disabled}
                  onChange={(x) => props.editSecret('credential.password', x)} />
              </>
            ) : (
              <TextRow id="tmim-credToken" label={key('credToken')} hint={key('credTokenHint')} secret
                value={props.text('credential.token')} disabled={disabled}
                onChange={(x) => props.editSecret('credential.token', x)} />
            )}
          </Section>

          <Section title={key('sectionInbound')}>
            <BoolRow id="tmim-wsEnabled" label={key('wsEnabled')} hint={key('wsEnabledHint')}
              checked={v.ws.enabled} disabled={disabled}
              onChange={(x) => props.editBool('ws.enabled', x)} />
            <TextRow id="tmim-wsUrl" label={key('wsUrl')} hint={key('wsUrlHint')}
              value={props.text('ws.url')} disabled={disabled}
              onChange={(x) => props.editText('ws.url', x)} />
            <NumberRow id="tmim-wsHeartbeat" label={key('wsHeartbeat')}
              value={props.text('ws.heartbeatMs')} disabled={disabled}
              onChange={(x) => props.editNumber('ws.heartbeatMs', x)} />

            <BoolRow id="tmim-whEnabled" label={key('webhookEnabled')} hint={key('webhookEnabledHint')}
              checked={v.webhook.enabled} disabled={disabled}
              onChange={(x) => props.editBool('webhook.enabled', x)} />
            <TextRow id="tmim-whPath" label={key('webhookPath')}
              value={props.text('webhook.path')} disabled={disabled}
              onChange={(x) => props.editText('webhook.path', x)} />
            <TextRow id="tmim-whSecret" label={key('webhookSecret')} hint={key('webhookSecretHint')} secret
              value={props.text('webhook.secret')} disabled={disabled}
              onChange={(x) => props.editSecret('webhook.secret', x)} />
            <NumberRow id="tmim-whSkew" label={key('webhookMaxSkew')}
              value={props.text('webhook.maxSkewSeconds')} disabled={disabled}
              onChange={(x) => props.editNumber('webhook.maxSkewSeconds', x)} />
          </Section>

          <Section title={key('sectionAgent')}>
            <BoolRow id="tmim-takeover" label={key('enableAgentTakeover')}
              hint={key('enableAgentTakeoverHint')} checked={v.enableAgentTakeover}
              disabled={disabled} onChange={(x) => props.editBool('enableAgentTakeover', x)} />
            <TextRow id="tmim-provider" label={key('agentProvider')}
              value={props.text('agent.provider')} disabled={disabled}
              onChange={(x) => props.editText('agent.provider', x)} />
            <TextRow id="tmim-model" label={key('agentModel')} hint={key('agentModelHint')}
              value={props.text('agent.model')} disabled={disabled}
              onChange={(x) => props.editText('agent.model', x)} />
            <TextRow id="tmim-preset" label={key('agentPreset')} hint={key('agentPresetHint')}
              value={props.text('agentPreset')} disabled={disabled}
              onChange={(x) => props.editText('agentPreset', x)} />
            <TextRow id="tmim-cwd" label={key('cwd')} hint={key('cwdHint')}
              value={props.text('cwd')} disabled={disabled}
              onChange={(x) => props.editText('cwd', x)} />
            <BoolRow id="tmim-tools" label={key('tools')} hint={key('toolsHint')}
              checked={v.tools} disabled={disabled}
              onChange={(x) => props.editBool('tools', x)} />
          </Section>
        </>
      )}
    </SettingsForm>
  )
}
