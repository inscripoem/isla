import type { ReactNode } from 'react'
import type { SelectionView, WaitingStage } from '../console-state'
import { Card, ChatRow, Empty, FactChip, Facts, Glyph, Particle, showRecords, type GlyphName } from '../design/ui'

/**
 * Pipeline visualisation and audit. The stepper lives on the stage wall as
 * the permanent journey view; the facts section keeps every runtime-reported
 * identity visible for audit. Nothing here is local playback evidence.
 */

const PIPELINE: readonly { readonly key: WaitingStage; readonly label: string; readonly icon: 'moon' | 'pause' | 'target' | 'voice' | 'package' }[] = [
  { key: 'idle', label: 'idle', icon: 'moon' },
  { key: 'awaiting-selection', label: 'awaiting', icon: 'pause' },
  { key: 'selected', label: 'selected', icon: 'target' },
  { key: 'speaking', label: 'speaking', icon: 'voice' },
  { key: 'delivered', label: 'delivered', icon: 'package' },
]

const STAGE_INDEX = new Map(PIPELINE.map((node, index) => [node.key as string, index]))

function stageClass(stage: string, nodeKey: string): string {
  const current = STAGE_INDEX.get(stage) ?? 0
  const node = STAGE_INDEX.get(nodeKey) ?? -1
  if (nodeKey === stage) return 'is-current is-reached'
  // The pipeline is a projection, not a monotonic history: highlight reached
  // nodes only up to the current stage for the happy path ordering.
  if (node >= 0 && node < current) return 'is-reached'
  return ''
}

/**
 * The waiting-stage stepper rendered on the stage wall. Stopped and
 * deferred are terminal projections outside the happy path; they light no
 * node and the badge beside the title carries the word.
 */
export function PipelineStepper({ stage }: { readonly stage: WaitingStage }) {
  return (
    <div className="isla-pipeline" role="img" aria-label={`Waiting stage: ${stage}`}>
      {PIPELINE.map((node) => (
        <div key={node.key} className={`isla-pipe-node ${stageClass(stage, node.key)}`.trim()}>
          <span className="isla-pipe__bullet" aria-hidden="true">
            <Glyph name={node.icon} size={16} />
          </span>
          <span className="isla-pipe__label">
            <Particle on={stageClass(stage, node.key).includes('is-reached')} pulse={stage === node.key} />
            {node.label}
          </span>
        </div>
      ))}
    </div>
  )
}

export function SelectionSection({ selection }: { readonly selection: SelectionView }) {
  const plan = selection.plan

  const selectionRows: readonly (readonly [string, ReactNode])[] = [
    ['Waiting stage', <FactChip key="ws" value={selection.stage} />],
    ['Plan disposition', <FactChip key="pd" value={plan === null ? 'none' : plan.disposition} />],
    ['Selected event ids', <FactChip key="se" value={plan === null ? 'none' : plan.selectedEventIds.join(', ') || 'none'} />],
    ['Reply intent', <FactChip key="ri" value={plan === null ? 'none' : (plan.replyIntent ?? 'none')} />],
    ['Plan reason code', <FactChip key="pr" value={plan === null ? 'none' : plan.reasonCode} />],
    ['Plan synthetic', <FactChip key="ps" value={plan === null ? 'unknown' : plan.synthetic ? 'yes' : 'no'} />],
    ['Turn reply intent', <FactChip key="tr" value={selection.replyIntent === null ? 'none' : selection.replyIntent.replyIntent} />],
    [
      'Turn id',
      <FactChip key="ti" value={selection.replyIntent === null ? 'none' : selection.replyIntent.turnId === null ? 'not reported' : selection.replyIntent.turnId} />,
    ],
    [
      'Delivery classification',
      <FactChip key="dc" value={selection.serverDelivery === null ? 'none' : selection.serverDelivery.classification} />,
    ],
    [
      'Delivery output',
      <FactChip key="do" value={selection.serverDelivery === null ? 'none' : selection.serverDelivery.outputId === null ? 'not reported' : selection.serverDelivery.outputId} />,
    ],
    [
      'Delivery turn',
      <FactChip key="dt" value={selection.serverDelivery === null ? 'none' : selection.serverDelivery.turnId === null ? 'not reported' : selection.serverDelivery.turnId} />,
    ],
    [
      'Delivery segment',
      <FactChip key="ds" value={selection.serverDelivery === null ? 'none' : selection.serverDelivery.segmentId === null ? 'not reported' : selection.serverDelivery.segmentId} />,
    ],
  ]

  return (
    <Card
      title="Plan and Delivery Facts"
      icon="route"
      className="isla-rise"
      collapsible
      defaultOpen={false}
    >
      <button
        type="button"
        className="isla-viewall"
        onClick={() =>
          showRecords(
            'Plan and Delivery Facts — all records',
            selectionRows.map((entry) => ({
              glyph: (entry[0].startsWith('Delivery') ? 'package' : 'route') as GlyphName,
              title: entry[0],
              meta: typeof entry[1] === 'string' ? entry[1] : '',
              type: entry[0].startsWith('Delivery') ? 'Delivery' : 'Plan',
            })),
          )
        }
      >
        View all {selectionRows.length} plan records
      </button>
      <Facts rows={selectionRows} />
      <p className="isla-card__caption">
        {selection.acceptedInputs.length === 0
          ? 'No accepted inputs observed yet.'
          : `${selection.acceptedInputs.length} accepted input${selection.acceptedInputs.length === 1 ? '' : 's'} observed.`}
      </p>
      {selection.acceptedInputs.length > 0 && (
        <ul className="isla-chat">
          {[...selection.acceptedInputs].reverse().map((entry) => (
            <ChatRow
              key={entry.eventId}
              name={entry.source}
              tone="applied"
              text={entry.text}
              meta={`#${entry.seq} · ${entry.eventId}`}
            />
          ))}
        </ul>
      )}
      {selection.acceptedInputs.length === 0 && <Empty>No accepted inputs observed.</Empty>}
    </Card>
  )
}
