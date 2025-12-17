import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

// Plotly-like palette (stable colors for a stable "key")
const TRACE_COLORS = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#7f7f7f',
  '#bcbd22',
  '#17becf',
]

function normalizeFieldName(name) {
  return String(name ?? '').trim()
}

function isNonEmptyString(x) {
  return typeof x === 'string' && x.trim().length > 0
}

function tryParseNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const s = String(value).trim()
  if (!s) return null
  const cleaned = s.replaceAll(',', '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function parseDateFlexible(value) {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (!raw) return null

  // Common CDC-ish formats: YYYY-MM-DD, MM/DD/YYYY, and "Week Ending Date" style strings
  const d1 = new Date(raw)
  if (!Number.isNaN(d1.getTime())) return d1

  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const mm = Number(m[1])
    const dd = Number(m[2])
    const yyyy = Number(m[3])
    const d2 = new Date(Date.UTC(yyyy, mm - 1, dd))
    if (!Number.isNaN(d2.getTime())) return d2
  }

  return null
}

const AUTOLOAD_PATH = '/data/overdose.csv'
const DEFAULT_JURISDICTION = 'United States'
const REQUIRED_COLUMNS = {
  jurisdiction: 'jurisdiction_occurrence',
  drug: 'drug_involved',
  date: 'month_ending_date',
  value: 'drug_overdose_deaths',
}

function App() {
  const chartElRef = useRef(null)
  const [status, setStatus] = useState('Loading…')
  const [error, setError] = useState('')
  const [rows, setRows] = useState([])

  const libsReady = useMemo(() => {
    const hasPapa = typeof window !== 'undefined' && window.Papa
    const hasPlotly = typeof window !== 'undefined' && window.Plotly
    return Boolean(hasPapa && hasPlotly)
  }, [])

  const loadCsvText = async (text, label = 'CSV') => {
    setError('')
    setStatus(`Parsing ${label}…`)

    if (!window.Papa) {
      setError('PapaParse is not available. Check your internet connection (CDN load).')
      setStatus('Failed to parse CSV.')
      return
    }

    const raw = typeof text === 'string' ? text : String(text ?? '')
    const trimmed = raw.trim()

    if (trimmed.length < 10) {
      setError(
        'The CSV appears to be empty (0 characters read).',
      )
      setStatus('Failed to parse CSV.')
      return
    }

    const parseWith = (delimiter) =>
      window.Papa.parse(raw, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => normalizeFieldName(h),
        ...(delimiter ? { delimiter } : {}),
      })

    // Attempt 1: PapaParse auto-detect
    let parsed = parseWith('')

    const hasDelimiterError = (p) =>
      Array.isArray(p?.errors) &&
      p.errors.some((e) => String(e?.message ?? '').toLowerCase().includes('delimiting character'))
    const tooFewFields =
      !Array.isArray(parsed?.meta?.fields) || parsed.meta.fields.filter(Boolean).length <= 1

    // Attempt 2: force comma delimiter (your dataset is comma-separated)
    if (hasDelimiterError(parsed) || tooFewFields) {
      parsed = parseWith(',')
    }

    if (parsed.errors?.length) {
      setError(parsed.errors[0]?.message ?? 'CSV parse error')
      setStatus('Failed to parse CSV.')
      return
    }

    const nextRows = Array.isArray(parsed.data) ? parsed.data : []
    const nextFields = Array.isArray(parsed.meta?.fields) ? parsed.meta.fields.filter(Boolean) : []

    if (!nextRows.length || !nextFields.length) {
      setError('No data found in CSV (missing header row or empty file).')
      setStatus('No data loaded.')
      return
    }

    const missing = Object.values(REQUIRED_COLUMNS).filter((c) => !nextFields.includes(c))
    if (missing.length) {
      setError(`CSV is missing required columns: ${missing.join(', ')}`)
      setStatus('No data loaded.')
      return
    }

    setRows(nextRows)
    setStatus(`Loaded ${nextRows.length.toLocaleString()} rows.`)
  }

  // Auto-load from public/data/overdose.csv
  useEffect(() => {
    let cancelled = false

    const tryAutoLoad = async () => {
      setStatus(`Loading ${AUTOLOAD_PATH}…`)
      try {
        const resp = await fetch(AUTOLOAD_PATH, { cache: 'no-store' })
        if (!resp.ok) {
          if (!cancelled) {
            setError(`Could not load ${AUTOLOAD_PATH}. Make sure it exists in public/data/.`)
            setStatus('No data loaded.')
          }
          return
        }
        const text = await resp.text()
        if (!cancelled) await loadCsvText(text, AUTOLOAD_PATH)
      } catch {
        if (!cancelled) {
          setError(`Could not load ${AUTOLOAD_PATH}.`)
          setStatus('No data loaded.')
        }
      }
    }

    tryAutoLoad()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tracesAndLayout = useMemo(() => {
    if (!rows.length) {
      return { traces: [], layout: null, meta: { usedRows: 0, droppedRows: 0 } }
    }

    const byDrug = new Map() // drug -> Map(dateISO -> valueSum)
    let usedRows = 0
    let droppedRows = 0

    for (const r of rows) {
      const j = String(r?.[REQUIRED_COLUMNS.jurisdiction] ?? '').trim()
      if (j !== DEFAULT_JURISDICTION) continue

      const drug = String(r?.[REQUIRED_COLUMNS.drug] ?? '').trim()
      if (!drug) {
        droppedRows += 1
        continue
      }

      const dateObj = parseDateFlexible(r?.[REQUIRED_COLUMNS.date])
      const value = tryParseNumber(r?.[REQUIRED_COLUMNS.value])
      if (!dateObj || value === null) {
        droppedRows += 1
        continue
      }

      const dateISO = dateObj.toISOString().slice(0, 10)
      if (!byDrug.has(drug)) byDrug.set(drug, new Map())
      const byDate = byDrug.get(drug)
      byDate.set(dateISO, (byDate.get(dateISO) ?? 0) + value)
      usedRows += 1
    }

    const traces = Array.from(byDrug.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([drug, byDate], idx) => {
        const pairs = Array.from(byDate.entries()).sort(([d1], [d2]) => d1.localeCompare(d2))
        const color = TRACE_COLORS[idx % TRACE_COLORS.length]
        return {
          name: drug,
          type: 'scatter',
          mode: 'lines+markers',
          x: pairs.map(([d]) => d),
          y: pairs.map(([, v]) => v),
          line: { color, width: 2 },
          marker: { color, size: 5 },
          hovertemplate: `<b>${drug}</b><br>%{x}: %{y}<extra></extra>`,
        }
      })

    const layout = {
      title: '',
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: 'rgba(255,255,255,0.9)' },
      margin: { l: 55, r: 170, t: 16, b: 55 },
      xaxis: { title: 'Month ending date', automargin: true },
      yaxis: { title: 'Drug overdose deaths (12-month ending)', automargin: true },
      legend: {
        title: { text: 'Drug (click to hide/show)' },
        orientation: 'v',
        x: 1.02,
        xanchor: 'left',
        y: 1,
        yanchor: 'top',
        bgcolor: 'rgba(0,0,0,0.25)',
        bordercolor: 'rgba(255,255,255,0.16)',
        borderwidth: 1,
        itemsizing: 'constant',
      },
      hovermode: 'x unified',
    }

    return { traces, layout, meta: { usedRows, droppedRows } }
  }, [rows])

  // Render chart
  useEffect(() => {
    if (!chartElRef.current) return
    if (!window.Plotly) return

    const { traces, layout } = tracesAndLayout
    if (!traces.length || !layout) {
      window.Plotly.purge(chartElRef.current)
      return
    }

    window.Plotly.react(chartElRef.current, traces, layout, {
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
    })
  }, [tracesAndLayout])

  return (
    <div className="app">
      <header className="headerBar">
        <div className="headerTitle">Overdose in US</div>
      </header>
      <div ref={chartElRef} className="chart" />
      <footer className="bottomStatement">
        Lets fix this. Opiods, Fentanyl, and other pain killers should not be given to people under
        20
      </footer>

      {(!libsReady || error || !rows.length) && (
        <div className="overlay" role="status" aria-live="polite">
          <div className="overlayTitle">{error ? 'Error' : 'Loading'}</div>
          <div className="overlayText">
            {!libsReady
              ? 'Waiting for charting libraries… (make sure you’re online)'
              : error
                ? error
                : status}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
