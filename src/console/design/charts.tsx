import type { ReactNode } from 'react'
import { Empty } from './ui'

/*
 * Chart primitives, drawn by hand in SVG so they speak the Nightloom
 * visual language. Chart forms follow the ui-ux-pro-max selection table:
 * categorical comparison -> horizontal bars, part-to-whole (<= 5 parts) ->
 * donut, live streams -> a rolling seq ticker. Every chart renders only
 * data the console actually observed and degrades to an honest empty
 * state when there is nothing to chart.
 */

/* --------------------------------------------------------------- *
 * SourceBars: categorical comparison as horizontal candy bars.
 * --------------------------------------------------------------- */

export interface BarEntry {
  readonly label: string
  readonly count: number
}

export function SourceBars({ entries }: { readonly entries: readonly BarEntry[] }) {
  if (entries.length === 0) {
    return <Empty>No inputs observed yet.</Empty>
  }
  const max = Math.max(...entries.map((entry) => entry.count), 1)
  const tones = ['var(--isla-pink)', 'var(--isla-sky)', 'var(--isla-yellow)', 'var(--isla-purple)', 'var(--isla-mint)']
  return (
    <div className="isla-bars" role="img" aria-label="Inputs by source">
      {entries.map((entry, index) => (
        <div key={entry.label} className="isla-bars__row">
          <span className="isla-bars__label">{entry.label}</span>
          <span className="isla-bars__track">
            <span
              className="isla-bars__fill"
              style={{ width: `${Math.max(6, Math.round((entry.count / max) * 100))}%`, background: tones[index % tones.length] }}
            />
          </span>
          <span className="isla-bars__count">{entry.count}</span>
        </div>
      ))}
    </div>
  )
}

/* --------------------------------------------------------------- *
 * OutcomeRing: part-to-whole donut for the request outcomes
 * (at most five slices per the chart-selection guidance).
 * --------------------------------------------------------------- */

export interface RingSlice {
  readonly label: string
  readonly count: number
}

const RING_TONES = ['var(--isla-mint)', 'var(--isla-purple)', 'var(--isla-red)', 'var(--isla-orange)', 'var(--isla-sky)']

export function OutcomeRing({ slices }: { readonly slices: readonly RingSlice[] }) {
  const real = slices.filter((slice) => slice.count > 0)
  if (real.length === 0) {
    return <Empty>No request outcomes yet.</Empty>
  }
  const total = real.reduce((sum, slice) => sum + slice.count, 0)
  const radius = 40
  const circumference = 2 * Math.PI * radius
  // Segments are computed before render so the JSX below stays immutable.
  const segments = real
    .map((slice, index) => ({
      slice,
      dash: (slice.count / total) * circumference,
      tone: RING_TONES[index % RING_TONES.length],
    }))
    .map((segment, index, all) => ({
      ...segment,
      offset: all.slice(0, index).reduce((sum, prior) => sum + prior.dash, 0),
    }))
  return (
    <div className="isla-ring">
      <svg viewBox="0 0 100 100" className="isla-ring__svg" role="img" aria-label="Request outcome share">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="12" />
        {segments.map((segment) => (
          <circle
            key={segment.slice.label}
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={segment.tone}
            strokeWidth="12"
            strokeDasharray={`${segment.dash} ${circumference - segment.dash}`}
            strokeDashoffset={-segment.offset}
            transform="rotate(-90 50 50)"
            strokeLinecap="butt"
          />
        ))}
        <text x="50" y="54" textAnchor="middle" className="isla-ring__total">{total}</text>
      </svg>
      <ul className="isla-ring__legend">
        {real.map((slice, index) => (
          <li key={slice.label} className="isla-ring__legend-row">
            <span className="isla-ring__swatch" style={{ background: RING_TONES[index % RING_TONES.length] }} aria-hidden="true" />
            <span className="isla-ring__label">{slice.label}</span>
            <span className="isla-ring__count">{slice.count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* --------------------------------------------------------------- *
 * SeqTicker: the live rolling feed — accepted inputs plotted on a
 * sequence axis, newest at the right edge, entering with a pop.
 * --------------------------------------------------------------- */

export interface TickPoint {
  readonly seq: number
  readonly label: string
}

export function SeqTicker({ points }: { readonly points: readonly TickPoint[] }) {
  if (points.length === 0) {
    return <Empty>No rolling data yet — dispatch an input to start the feed.</Empty>
  }
  const first = points[0]!.seq
  const last = points[points.length - 1]!.seq
  const span = Math.max(1, last - first)
  return (
    <div className="isla-ticker" role="img" aria-label={`Rolling input feed, sequence ${first} to ${last}`}>
      <span className="isla-ticker__axis" aria-hidden="true" />
      {points.map((point) => {
        const left = ((point.seq - first) / span) * 100
        return (
          <span
            key={`${point.seq}-${point.label}`}
            className="isla-ticker__dot"
            style={{ left: `calc(${left.toFixed(2)}% + 12px)` }}
            title={`#${point.seq} ${point.label}`}
          >
            <span className="isla-ticker__tip">{point.label}</span>
          </span>
        )
      })}
      <span className="isla-ticker__seq">#{last}</span>
    </div>
  )
}

export function ChartCardRows({ children }: { readonly children: ReactNode }) {
  return <div className="isla-charts">{children}</div>
}
