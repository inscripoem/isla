import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import type { PlaybackView } from '../console-state'
import { Card, ChatRow, Empty, showRecords } from '../design/ui'
import { formatDuration } from '../design/format'

/**
 * Receipts section: local output observation. Receipts and faults here are
 * recorded by this browser and are local evidence only; the section never
 * claims runtime-confirmed delivery from them. The stage itself lives on the
 * cockpit's stage wall; this section is the ledger underneath it.
 */

const METER_STAGES = ['accepted', 'started', 'completed', 'cancelled', 'failed', 'unknown'] as const

function stageTone(stage: string): 'accepted' | 'applied' | 'pending' | 'rejected' | 'unknown' {
  switch (stage) {
    case 'completed':
    case 'started':
      return 'accepted'
    case 'accepted':
      return 'applied'
    case 'cancelled':
      return 'pending'
    case 'failed':
      return 'rejected'
    default:
      return 'unknown'
  }
}

export interface PlaybackSectionProps {
  readonly playback: PlaybackView
  readonly localEvidenceNote: string
}

export function PlaybackSection({ playback }: PlaybackSectionProps) {
  const counts = useMemo(() => {
    const byStage = new Map<string, number>(METER_STAGES.map((stage) => [stage, 0]))
    for (const receipt of playback.receipts) {
      byStage.set(receipt.stage, (byStage.get(receipt.stage) ?? 0) + 1)
    }
    return METER_STAGES.map((stage) => ({ stage, count: byStage.get(stage) ?? 0 }))
  }, [playback.receipts])

  const maxCount = Math.max(1, ...counts.map((entry) => entry.count))
  const recentReceipts = useMemo(() => playback.receipts.slice(-18), [playback.receipts])

  return (
    <Card
      title="Local Receipts"
      icon="chart"
      tone="lime"
      className="isla-rise"
      collapsible
    >
      {playback.receipts.length === 0 ? (
        <Empty>No receipts observed yet.</Empty>
      ) : (
        <>
          <div className="isla-meter" role="img" aria-label="Receipt count by stage">
            {counts.map((entry) => (
              <div className="isla-meter__col" key={entry.stage}>
                <span className="isla-meter__count">{entry.count}</span>
                <div
                  className={`isla-meter__bar isla-meter__fill--${entry.stage}`}
                  style={{ height: `${Math.max(6, Math.round((entry.count / maxCount) * 100))}%` }}
                />
                <span className="isla-meter__label">{entry.stage}</span>
              </div>
            ))}
          </div>
          <div className="isla-strip" aria-hidden="true">
            {recentReceipts.map((receipt) => (
              <span
                key={receipt.receiptId}
                className={`isla-strip__dot isla-meter__fill--${receipt.stage}`}
                title={`${receipt.stage} · ${receipt.outputId}`}
              />
            ))}
          </div>
          {playback.receipts.length > 7 && (
            <button type="button" className="isla-viewall" onClick={() => showRecords('All local receipts', playback.receipts.slice().reverse().map((receipt) => ({ glyph: 'chart', title: `${receipt.stage} · ${receipt.outputId}`, meta: `${receipt.modality}${receipt.reasonCode === null ? '' : ` · ${receipt.reasonCode}`}${receipt.localTimeMs === null ? '' : ` · ${formatDuration(receipt.localTimeMs)}`}`, tone: receipt.stage === 'failed' ? 'bad' : receipt.stage === 'completed' ? 'ok' : 'plain', type: receipt.stage })))}>
              View all {playback.receipts.length} receipt records
            </button>
          )}
          <ul className="isla-chat">
            {[...playback.receipts].slice(-7).reverse().map((receipt) => (
              <ChatRow
                key={receipt.receiptId}
                name="player"
                tone={stageTone(receipt.stage)}
                text={`${receipt.stage} · ${receipt.outputId}`}
                meta={`${receipt.modality}${receipt.reasonCode === null ? '' : ` · ${receipt.reasonCode}`}${receipt.localTimeMs === null ? '' : ` · ${formatDuration(receipt.localTimeMs)}`}`}
              />
            ))}
          </ul>
        </>
      )}
      {playback.faults.length > 0 && (
        <>
          <hr className="isla-divider" />
          <ul className="isla-chat">
            {[...playback.faults].reverse().map((fault, index) => (
              <li
                key={`${index}-${fault}`}
                className="isla-chat__item"
                style={{ '--chat-bar': 'var(--isla-red)', '--chat-bg': 'var(--isla-red-soft)', '--chat-name': 'var(--isla-red)' } as CSSProperties}
              >
                <span className="isla-chat__name">fault</span>
                <span className="isla-chat__detail">{fault}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}
