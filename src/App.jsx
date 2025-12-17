import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

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

function guessColumns(fields) {
  const lower = fields.map((f) => f.toLowerCase())

  const findBy = (reList) => {
    for (const re of reList) {
      const idx = lower.findIndex((x) => re.test(x))
      if (idx !== -1) return fields[idx]
    }
    return ''
  }

  const drug = findBy([/\bdrug\b/, /\bsubstance\b/, /\bopioid\b/, /\bcategory\b/])
  const date = findBy([/\bdate\b/, /\bweek\b/, /\bmonth\b/, /\bperiod\b/, /\bending\b/])
  const value = findBy([/\bdeaths?\b/, /\bdeath\b/, /\bcount\b/, /\bnumber\b/, /\bvalue\b/])

  return { drug, date, value }
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter((v) => isNonEmptyString(v)).map((v) => v.trim()))).sort(
    (a, b) => a.localeCompare(b),
  )
}

function App() {
  const chartElRef = useRef(null)
  const [status, setStatus] = useState('Loading…')
  const [error, setError] = useState('')
  const [rows, setRows] = useState([])
  const [fields, setFields] = useState([])

  const [drugColumn, setDrugColumn] = useState('')
  const [dateColumn, setDateColumn] = useState('')
  const [valueColumn, setValueColumn] = useState('')

  const [drugFilterText, setDrugFilterText] = useState('')
  const [selectedDrugs, setSelectedDrugs] = useState([])

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

    const parsed = window.Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => normalizeFieldName(h),
    })

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

    setRows(nextRows)
    setFields(nextFields)

    const guessed = guessColumns(nextFields)
    setDrugColumn((prev) => prev || guessed.drug || nextFields[0] || '')
    setDateColumn((prev) => prev || guessed.date || nextFields[0] || '')
    setValueColumn((prev) => prev || guessed.value || nextFields[0] || '')

    setStatus(`Loaded ${nextRows.length.toLocaleString()} rows.`)
  }

  // Auto-load if user copies the file into public/data/overdose.csv
  useEffect(() => {
    let cancelled = false

    const tryAutoLoad = async () => {
      setStatus('Looking for public/data/overdose.csv…')
      try {
        const resp = await fetch('/data/overdose.csv', { cache: 'no-store' })
        if (!resp.ok) {
          if (!cancelled) setStatus('No auto-loaded CSV found. Use "Upload CSV" to load your file.')
          return
        }
        const text = await resp.text()
        if (!cancelled) await loadCsvText(text, 'public/data/overdose.csv')
      } catch {
        if (!cancelled) setStatus('No auto-loaded CSV found. Use "Upload CSV" to load your file.')
      }
    }

    tryAutoLoad()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const drugOptions = useMemo(() => {
    if (!rows.length || !drugColumn) return []
    return uniqueSorted(rows.map((r) => r?.[drugColumn]))
  }, [rows, drugColumn])

  const filteredDrugOptions = useMemo(() => {
    if (!drugFilterText.trim()) return drugOptions
    const q = drugFilterText.trim().toLowerCase()
    return drugOptions.filter((d) => d.toLowerCase().includes(q))
  }, [drugOptions, drugFilterText])

  // Ensure selected drugs remain valid after column changes / file loads.
  useEffect(() => {
    setSelectedDrugs((prev) => prev.filter((d) => drugOptions.includes(d)))
  }, [drugOptions])

  const tracesAndLayout = useMemo(() => {
    if (!rows.length || !drugColumn || !dateColumn || !valueColumn) {
      return { traces: [], layout: null, meta: { usedRows: 0, droppedRows: 0 } }
    }

    const allowed = selectedDrugs.length ? new Set(selectedDrugs) : null
    const byDrug = new Map() // drug -> Map(dateISO -> valueSum)
    let usedRows = 0
    let droppedRows = 0

    for (const r of rows) {
      const drug = String(r?.[drugColumn] ?? '').trim()
      if (!drug) {
        droppedRows += 1
        continue
      }
      if (allowed && !allowed.has(drug)) {
        continue
      }

      const dateObj = parseDateFlexible(r?.[dateColumn])
      const value = tryParseNumber(r?.[valueColumn])
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
      .map(([drug, byDate]) => {
        const pairs = Array.from(byDate.entries()).sort(([d1], [d2]) => d1.localeCompare(d2))
        return {
          name: drug,
          type: 'scatter',
          mode: 'lines+markers',
          x: pairs.map(([d]) => d),
          y: pairs.map(([, v]) => v),
          hovertemplate: `<b>${drug}</b><br>%{x}: %{y}<extra></extra>`,
        }
      })

    const layout = {
      title: 'Provisional Drug Overdose Death Counts (segment by drug)',
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: 'rgba(255,255,255,0.9)' },
      margin: { l: 50, r: 20, t: 60, b: 50 },
      xaxis: { title: dateColumn, automargin: true },
      yaxis: { title: valueColumn, automargin: true },
      legend: { orientation: 'h', x: 0, y: 1.12 },
      hovermode: 'x unified',
    }

    return { traces, layout, meta: { usedRows, droppedRows } }
  }, [rows, drugColumn, dateColumn, valueColumn, selectedDrugs])

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

  const onUpload = async (file) => {
    if (!file) return
    setStatus(`Reading ${file.name}…`)
    setError('')

    try {
      const text = await file.text()
      await loadCsvText(text, file.name)
      setSelectedDrugs([])
    } catch (e) {
      setError(e?.message ?? 'Failed to read file.')
      setStatus('No data loaded.')
    }
  }

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1 className="title">US Drug Overdose Dashboard</h1>
          <p className="subtitle">
            Load the CSV and segment the time series by <b>drug</b>.
          </p>
        </div>
        <div className="hint">
          <div>
            Auto-load path: <code>public/data/overdose.csv</code>
          </div>
      <div>
            Or use upload below (recommended).
          </div>
        </div>
      </div>

      {!libsReady && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <b>Waiting on charting libraries…</b>
          <div className="status">
            This page loads PapaParse + Plotly from CDNs; make sure you’re online.
          </div>
        </div>
      )}

      <div className="panel">
        <div className="controls">
          <div className="controlRow">
            <label>
              <b>Upload CSV</b>
            </label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => onUpload(e.target.files?.[0] ?? null)}
            />
            <small>
              Tip: select your file from <code>C:\Users\joyar\Downloads\</code>.
            </small>
          </div>

          <div className="controlRow">
            <label>
              <b>Filter drugs</b> (optional)
            </label>
            <input
              type="text"
              placeholder="Search drugs…"
              value={drugFilterText}
              onChange={(e) => setDrugFilterText(e.target.value)}
            />
            <small>
              Leave unselected to show <b>all drugs</b> as separate lines.
            </small>
          </div>

          <div className="controlRow">
            <label>
              <b>Drug column</b>
            </label>
            <select value={drugColumn} onChange={(e) => setDrugColumn(e.target.value)}>
              {fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          <div className="controlRow">
            <label>
              <b>Date column</b>
            </label>
            <select value={dateColumn} onChange={(e) => setDateColumn(e.target.value)}>
              {fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          <div className="controlRow">
            <label>
              <b>Value column</b> (deaths/count)
            </label>
            <select value={valueColumn} onChange={(e) => setValueColumn(e.target.value)}>
              {fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>

          <div className="controlRow">
            <label>
              <b>Select drugs</b> (multi-select)
            </label>
            <select
              className="drugSelect"
              multiple
              value={selectedDrugs}
              onChange={(e) => {
                const next = Array.from(e.target.selectedOptions).map((o) => o.value)
                setSelectedDrugs(next)
              }}
            >
              {filteredDrugOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>

            <div className="actions">
              <button className="btn" type="button" onClick={() => setSelectedDrugs([])}>
                Clear selection (show all)
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => setSelectedDrugs(filteredDrugOptions.slice(0, 5))}
                disabled={!filteredDrugOptions.length}
              >
                Select first 5
        </button>
            </div>
          </div>
        </div>

        <div className="status">
          <div>
            <b>Status:</b> {status}
          </div>
          {error && (
            <div style={{ marginTop: 6 }}>
              <b>Error:</b> {error}
            </div>
          )}
          {!!rows.length && (
            <div style={{ marginTop: 6, opacity: 0.9 }}>
              Using {tracesAndLayout.meta.usedRows.toLocaleString()} rows (dropped{' '}
              {tracesAndLayout.meta.droppedRows.toLocaleString()} for missing date/value/drug).
            </div>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <div ref={chartElRef} className="chart" />
        </div>
      </div>
    </div>
  )
}

export default App
