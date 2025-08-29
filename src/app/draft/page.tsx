// MLBB Draft Counter — Beautiful Purple Edition (Dual Ad Rails + Tight Pick/Ban Spacing)
// -----------------------------------------------------------------------------
// Drop-in for app/draft/page.tsx (Next.js App Router).
// - Centered purple UI with *both* left & right AdSense rails (hidden on small screens)
// - Tighter vertical spacing between Picks and Bans
// - Fuzzy correction on Enter/blur only
// - BroadcastChannel live sync (no external deps), reads /public/counters.csv
// - Sticky win-rate footer after 5v5
//
// Requires Tailwind in your project.
// -----------------------------------------------------------------------------

'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
// import lanesCSV from '@/public/lanes.csv' // Removed: fetch dynamically in useEffect below

// ---------------- Types ----------------
type MatchupScore = { my_hero: string; enemy_hero: string; score: number }
type Assignment = Record<string, { hero: string; score: number } | null>
type DraftState = {
  room: string
  k: number
  teamA: string[]
  teamB: string[]
  bansA: string[]
  bansB: string[]
}

const DEFAULT_ROOM = 'public'
const emptyState: DraftState = {
  room: DEFAULT_ROOM,
  k: 5,
  teamA: Array(5).fill(''),
  teamB: Array(5).fill(''),
  bansA: Array(5).fill(''),
  bansB: Array(5).fill(''),
}

// ---------------- Helpers ----------------
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
function lev(a: string, b: string) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}
function parseCSV(text: string): MatchupScore[] {
  if (!text) return []
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // BOM
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  const lines = raw.map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  if (!lines.length) return []
  const sniff = (s: string) => (s.includes('\t') ? '\t' : s.includes(';') ? ';' : ',')
  const delim = sniff(lines[0])
  const header = lines[0].split(delim).map(h => h.replace(/^['"]|['"]$/g, '').trim().toLowerCase())
  const map: Record<string, number> = {}; header.forEach((h, i) => (map[h] = i))
  const idxMy = map['my_hero'] ?? map['my hero'] ?? map['myhero'] ?? map['hero']
  const idxEn = map['enemy_hero'] ?? map['enemy hero'] ?? map['enemyhero'] ?? map['enemy']
  const idxSc = map['score'] ?? map['adv'] ?? map['advantage']
  if (idxMy == null || idxEn == null || idxSc == null) return []
  const rows: MatchupScore[] = []
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(delim)
    if (p.length <= Math.max(idxMy, idxEn, idxSc)) continue
    const myh = p[idxMy]?.replace(/^['"]|['"]$/g, '').trim()
    const enh = p[idxEn]?.replace(/^['"]|['"]$/g, '').trim()
    const sc  = Number((p[idxSc] || '').replace(/^['"]|['"]$/g, '').trim().replace(',', '.'))
    if (!myh || !enh || Number.isNaN(sc)) continue
    rows.push({ my_hero: myh, enemy_hero: enh, score: sc })
  }
  return rows
}
function buildHeroResolver(rows: MatchupScore[]) {
  const set = new Set<string>(); rows.forEach(r => { set.add(r.my_hero); set.add(r.enemy_hero) })
  const heroes = Array.from(set)
  const indexed = heroes.map(h => ({ canonical: h, key: norm(h) }))
  const exact = new Map<string, string>(); indexed.forEach(({ canonical, key }) => exact.set(key, canonical))
  function resolve(input: string) {
    const s = (input || '').trim(); if (!s) return ''
    const k = norm(s); const hit = exact.get(k); if (hit) return hit
    let best = '', bestScore = Infinity
    for (const { canonical, key } of indexed) {
      const d = lev(k, key); if (d < bestScore) { bestScore = d; best = canonical }
    }
    const tlen = Math.max(2, Math.min(k.length, best.length))
    const threshold = Math.max(2, Math.ceil(tlen * 0.4))
    return best && bestScore <= threshold ? best : s
  }
  return { heroes, resolve }
}
function greedySuggest(rows: MatchupScore[], enemies: string[], k = 5) {
  const remaining = new Set(enemies.map(e => e.trim()).filter(Boolean))
  const usedHeroes = new Set<string>()
  const candidates: { score: number; my: string; en: string }[] = []
  for (const r of rows) if (remaining.has(r.enemy_hero)) candidates.push({ score: r.score, my: r.my_hero, en: r.enemy_hero })
  candidates.sort((a, b) => b.score - a.score)
  const chosen: string[] = []; const assignment: Assignment = Object.fromEntries([...remaining].map(e => [e, null])); let total = 0
  while (remaining.size && chosen.length < k && candidates.length) {
    const c = candidates.shift()!
    if (c && remaining.has(c.en) && !usedHeroes.has(c.my)) {
      remaining.delete(c.en); usedHeroes.add(c.my); chosen.push(c.my); assignment[c.en] = { hero: c.my, score: c.score }; total += c.score
      for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].my === c.my || candidates[i].en === c.en) candidates.splice(i, 1)
    }
  }
  return { chosen: [...new Set(chosen)], assignment, total }
}
const logistic = (x: number, k = 0.22) => 1 / (1 + Math.exp(-k * x))
function sumAdvantage(rows: MatchupScore[], teamA: string[], teamB: string[]) {
  const A = teamA.filter(Boolean), B = teamB.filter(Boolean)
  let sum = 0; for (const a of A) for (const b of B) { const r = rows.find(x => norm(x.my_hero) === norm(a) && norm(x.enemy_hero) === norm(b)); if (r) sum += r.score }
  return sum
}
function computeWinRate(rows: MatchupScore[], teamA: string[], teamB: string[]) {
  const aOverB = sumAdvantage(rows, teamA, teamB), bOverA = sumAdvantage(rows, teamB, teamA)
  const net = aOverB - bOverA, pct = Math.round(logistic(net) * 100), clamped = Math.max(5, Math.min(95, pct))
  return { percentA: clamped, net, aOverB, bOverA }
}

// --- Lane mapping helper ---
type LaneMap = Record<string, string>
function parseLaneCSV(text: string): LaneMap {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l && !l.startsWith('#'))
  const map: LaneMap = {}
  for (let i = 1; i < lines.length; i++) {
    const [hero, lane] = lines[i].split(',')
    if (hero && lane) map[hero.trim()] = lane.trim()
  }
  return map
}

// ---------------- Realtime (BroadcastChannel; no external deps) ----------------
function useRealtime(room: string, setState: React.Dispatch<React.SetStateAction<DraftState>>) {
  const bcRef = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    try {
      bcRef.current?.close()
      bcRef.current = new BroadcastChannel(`draft:${room}`)
      bcRef.current.onmessage = (ev) => { const st = ev.data as DraftState; if (st?.room === room) setState(st) }
    } catch {}
    return () => { try { bcRef.current?.close() } catch {} }
  }, [room, setState])
  const broadcast = (st: DraftState) => { try { bcRef.current?.postMessage(st) } catch {} }
  return broadcast
}

// ---------------- UI ----------------
export default function DraftPage() {
  const [rows, setRows] = useState<MatchupScore[]>([])
  const [state, setState] = useState<DraftState>(emptyState)
  const [roomInput, setRoomInput] = useState<string>(DEFAULT_ROOM)
  const [laneMap, setLaneMap] = useState<LaneMap>({})
  const broadcast = useRealtime(state.room, setState)

  const { heroes, resolve } = useMemo(() => buildHeroResolver(rows), [rows])
  const suggestions = useMemo(() => greedySuggest(rows, state.teamB.filter(Boolean), state.k), [rows, state.teamB, state.k])
  const win = useMemo(() => computeWinRate(rows, state.teamA, state.teamB), [rows, state.teamA, state.teamB])
  const allPicked = state.teamA.every(Boolean) && state.teamB.every(Boolean)

  async function loadDefaultCounters() {
    try {
      const url = new URL('counters.csv', window.location.origin).toString()
      const res = await fetch(url, { cache: 'no-store' }); if (!res.ok) return
      const text = await res.text(); const parsed = parseCSV(text); if (parsed.length) setRows(parsed)
    } catch (e) { console.error('counters.csv load error:', e) }
  }
  useEffect(() => {
    loadDefaultCounters()
    const url = new URL(window.location.href); const r = url.searchParams.get('room'); if (r && r !== state.room) setState(s => ({ ...s, room: r }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    async function loadLanes() {
      try {
        const url = new URL('lanes.csv', window.location.origin).toString()
        const res = await fetch(url, { cache: 'no-store' }); if (!res.ok) return
        const text = await res.text()
        setLaneMap(parseLaneCSV(text))
      } catch (e) { console.error('lanes.csv load error:', e) }
    }
    loadLanes()
  }, [])

  function pushState(st: DraftState) { setState(st); broadcast?.(st) }
  function applyRoom() { setState(s => ({ ...s, room: roomInput || DEFAULT_ROOM })) }
  function updatePick(team: 'A' | 'B', idx: number, inputVal: string) { const arr = team === 'A' ? [...state.teamA] : [...state.teamB]; arr[idx] = inputVal; pushState({ ...state, teamA: team === 'A' ? arr : state.teamA, teamB: team === 'B' ? arr : state.teamB }) }
  function updateBan(team: 'A' | 'B', idx: number, inputVal: string) { const arr = team === 'A' ? [...state.bansA] : [...state.bansB]; arr[idx] = inputVal; pushState({ ...state, bansA: team === 'A' ? arr : state.bansA, bansB: team === 'B' ? arr : state.bansB }) }
  function finalizePick(team: 'A' | 'B', idx: number) { const arr = team === 'A' ? [...state.teamA] : [...state.teamB]; const resolved = resolve(arr[idx] || ''); if (resolved !== arr[idx]) { arr[idx] = resolved; pushState({ ...state, teamA: team === 'A' ? arr : state.teamA, teamB: team === 'B' ? arr : state.teamB }) } }
  function finalizeBan(team: 'A' | 'B', idx: number) { const arr = team === 'A' ? [...state.bansA] : [...state.bansB]; const resolved = resolve(arr[idx] || ''); if (resolved !== arr[idx]) { arr[idx] = resolved; pushState({ ...state, bansA: team === 'A' ? arr : state.bansA, bansB: team === 'B' ? arr : state.bansB }) } }

  const laneLimitedSuggestions = useMemo(() => {
    if (!laneMap || !suggestions.chosen.length) return []
    const usedLanes = new Set<string>()
    const picks: string[] = []
    for (const hero of suggestions.chosen) {
      const lane = laneMap[hero]
      if (lane && !usedLanes.has(lane)) {
        picks.push(hero)
        usedLanes.add(lane)
      }
      if (usedLanes.size >= 5) break // Only 5 lanes
    }
    return picks
  }, [suggestions.chosen, laneMap])

  return (
    <div className="min-h-screen bg-gradient-to-b from-purple-950 via-purple-950 to-fuchsia-950 text-purple-50 selection:bg-fuchsia-500/30">
      {/* Frame: 12-col with dual ad rails on xl+ */}
      <div className="max-w-[1400px] mx-auto px-4 py-6 grid grid-cols-12 gap-6">
        {/* LEFT AD RAIL */}
        <aside className="hidden xl:block col-span-2">
          <AdRail />
        </aside>

        {/* MAIN CONTENT */}
        <main className="col-span-12 xl:col-span-8">
          {/* Header */}
          <div className="relative overflow-hidden rounded-3xl border border-fuchsia-800/30 bg-white/5 shadow-[0_2px_30px_rgba(168,85,247,.15)]">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_-10%,rgba(255,255,255,.15),transparent_60%)]" />
            <div className="relative px-6 py-5 flex items-center gap-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-fuchsia-500/20 border border-fuchsia-400/30 text-xl">⚔️</div>
              <div>
                <h1 className="text-xl md:text-2xl font-semibold tracking-tight">MLBB Draft Counter</h1>
                <p className="text-xs md:text-sm text-purple-200/80">Live draft helper • Reads <code>/public/counters.csv</code></p>
              </div>
              <div className="ml-auto hidden md:flex gap-2 text-[11px] text-purple-200/80">
                <span className="px-2 py-1 rounded-lg bg-white/5 border border-purple-800/40">Room: <code>{state.room}</code></span>
                <span className="px-2 py-1 rounded-lg bg-white/5 border border-purple-800/40">Rows: <strong>{rows.length}</strong></span>
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="grid md:grid-cols-2 gap-6 mt-6">
            <div className="rounded-2xl p-4 border border-purple-800/40 bg-white/5 backdrop-blur-sm shadow-inner">
              <h3 className="flex items-center gap-2 font-medium mb-3">👥 Room</h3>
              <div className="flex gap-2">
                <input
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  placeholder="public"
                  className="flex-1 bg-purple-950/50 rounded-xl px-3 py-2 text-sm outline-none border border-purple-800/60 focus:ring-2 focus:ring-fuchsia-500/40"
                />
                <button onClick={applyRoom} className="px-3 py-2 rounded-xl text-sm border border-purple-800/60 bg-purple-950/50 hover:bg-purple-900/50 transition">Join</button>
                <button
                  onClick={() => { const u = new URL(window.location.href); u.searchParams.set('room', state.room); navigator.clipboard.writeText(u.toString()) }}
                  className="px-3 py-2 rounded-xl text-sm border border-purple-800/60 bg-purple-950/50 hover:bg-purple-900/50 transition"
                >
                  Copy Link
                </button>
              </div>
            </div>

            <div className="rounded-2xl p-4 border border-purple-800/40 bg-white/5 backdrop-blur-sm shadow-inner">
              <h3 className="flex items-center gap-2 font-medium mb-3">🛡️ Settings</h3>
              <div className="flex items-center gap-3">
                <label className="text-sm">Max suggestions (K)</label>
                <input
                  type="number"
                  value={state.k}
                  min={1}
                  max={5}
                  onChange={(e) => pushState({ ...state, k: Math.max(1, Math.min(5, Number(e.target.value) || 5)) })}
                  className="w-24 bg-purple-950/50 rounded-xl px-3 py-2 text-sm outline-none border border-purple-800/60 focus:ring-2 focus:ring-fuchsia-500/40"
                />
                <button onClick={() => pushState({ ...emptyState, room: state.room })} className="ml-auto inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm border border-purple-800/60 bg-purple-950/50 hover:bg-purple-900/50 transition">
                  ♻️ Reset
                </button>
              </div>
            </div>
          </div>

          {/* Draft boards */}
          <div className="grid md:grid-cols-2 gap-6 mt-6">
            <TeamBoard
              title="Team A (You)"
              picks={state.teamA}
              bans={state.bansA}
              onPick={(i, v) => updatePick('A', i, v)}
              onBan={(i, v) => updateBan('A', i, v)}
              onFinalizePick={(i) => finalizePick('A', i)}
              onFinalizeBan={(i) => finalizeBan('A', i)}
              color="from-fuchsia-400/15 to-transparent"
            />
            <TeamBoard
              title="Team B (Enemy)"
              picks={state.teamB}
              bans={state.bansB}
              onPick={(i, v) => updatePick('B', i, v)}
              onBan={(i, v) => updateBan('B', i, v)}
              onFinalizePick={(i) => finalizePick('B', i)}
              onFinalizeBan={(i) => finalizeBan('B', i)}
              color="from-purple-400/15 to-transparent"
            />
          </div>

          {/* Suggestions */}
          <div className="mt-6 rounded-2xl p-5 border border-purple-800/40 bg-white/5 shadow-inner">
            <div className="flex items-center gap-2 mb-3">
              <span>✨</span><h3 className="text-lg font-semibold">Suggested picks vs Team B (one per lane)</h3>
            </div>
            {!rows.length || !Object.keys(laneMap).length ? (
              <p className="text-sm text-purple-200/80">Waiting for <code>/public/counters.csv</code> and <code>/public/lanes.csv</code>…</p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm">Total counter score: <span className="font-semibold">{suggestions.total.toFixed(2)}</span></p>
                <div className="text-sm">
                  <span className="text-purple-200/80">Best picks (one per lane):</span>{' '}
                  {laneLimitedSuggestions.length ? laneLimitedSuggestions.join(', ') : '(none)'}
                </div>
                <ul className="mt-2 text-sm grid md:grid-cols-2 gap-2">
                  {laneLimitedSuggestions.map(hero => {
                    const lane = laneMap[hero]
                    const score = suggestions.chosen.includes(hero)
                      ? suggestions.assignment[state.teamB.find(e => suggestions.assignment[e]?.hero === hero) ?? '']?.score
                      : null
                    return (
                      <li key={hero} className="bg-purple-950/40 border border-purple-800/60 rounded-xl px-3 py-2">
                        <span className="font-semibold">{hero}</span>
                        <span className="ml-2 text-purple-200/80">({lane})</span>
                        {score !== null && (
                          <span className="ml-2 text-purple-200/70">score +{score?.toFixed(2)}</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>

          {/* Footer note */}
          <div className="mt-6 text-xs text-purple-200/70 flex items-center gap-2">🔁 Data syncs live across open tabs in the same room.</div>
        </main>

        {/* RIGHT AD RAIL */}
        <aside className="hidden xl:block col-span-2">
          <AdRail />
        </aside>
      </div>

      {/* Win-rate bar */}
      <WinRateBar
        visible={allPicked}
        percentA={win.percentA}
        net={win.net}
        aOverB={win.aOverB}
        bOverA={win.bOverA}
      />
    </div>
  )
}

function TeamBoard({
  title, picks, bans, onPick, onBan, onFinalizePick, onFinalizeBan, color,
}: {
  title: string
  picks: string[]
  bans: string[]
  onPick: (idx: number, v: string) => void
  onBan: (idx: number, v: string) => void
  onFinalizePick?: (idx: number) => void
  onFinalizeBan?: (idx: number) => void
  color: string
}) {
  const pickedCount = picks.filter(Boolean).length
  return (
    <section className="relative rounded-3xl border border-purple-800/40 bg-white/[.06] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,.05)] overflow-hidden">
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-b ${color}`} />
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-base md:text-lg font-semibold tracking-tight">{title}</h3>
          <div className="text-xs">Picks: <span className="font-semibold">{pickedCount}/5</span></div>
        </div>

        {/* Picks (tight gap) */}
        <div className="grid grid-cols-5 gap-2">
          {picks.map((v, i) => (
            <div key={i} className="aspect-square rounded-lg border border-purple-800/60 bg-purple-950/50 p-2 flex flex-col">
              <input
                value={v}
                onChange={(e) => onPick(i, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onFinalizePick?.(i) } }}
                onBlur={() => onFinalizePick?.(i)}
                placeholder={`Pick ${i + 1}`}
                className="bg-transparent text-sm outline-none placeholder:text-purple-200/60"
              />
              {v && (
                <button
                  onClick={() => onPick(i, '')}
                  className="mt-auto self-end inline-flex items-center gap-1 text-[11px] px-2 py-1 border border-purple-700 rounded-md hover:bg-purple-900/50 transition"
                >
                  Clear
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Bans header tightened */}
        <div className="mt-2 text-[13px] text-purple-200/80">Bans (optional)</div>

        {/* Bans (tight gap & compact inputs) */}
        <div className="grid grid-cols-5 gap-2 mt-1">
          {bans.map((v, i) => (
            <div key={i} className="rounded-lg border border-purple-800/60 bg-purple-950/40 px-2 py-1.5">
              <input
                value={v}
                onChange={(e) => onBan(i, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onFinalizeBan?.(i) } }}
                onBlur={() => onFinalizeBan?.(i)}
                placeholder={`Ban ${i + 1}`}
                className="bg-transparent text-sm outline-none placeholder:text-purple-200/60"
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function WinRateBar({ visible, percentA, net, aOverB, bOverA }: {
  visible: boolean; percentA: number; net: number; aOverB: number; bOverA: number
}) {
  if (!visible) return null
  const percentB = 100 - percentA
  return (
    <div className="sticky bottom-0 left-0 right-0 border-t border-fuchsia-800/40 bg-black/30 backdrop-blur">
      <div className="max-w-[1400px] mx-auto px-4 py-3">
        <div className="flex items-center gap-3 mb-2">
          <span>🏆</span>
          <div className="text-sm font-medium">Win Rate (after 5v5 picks)</div>
          <div className="ml-auto text-xs text-purple-200/70">Net advantage: {net.toFixed(2)} (A over B)</div>
        </div>
        <div className="w-full h-4 rounded-xl overflow-hidden border border-fuchsia-800/50">
          <div className="h-full bg-gradient-to-r from-fuchsia-400 to-purple-400" style={{ width: `${percentA}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-xs">
          <span>Team A: {percentA}%</span>
          <span>Team B: {percentB}%</span>
        </div>
        <div className="mt-1 text-[11px] text-purple-200/70">A vs B total: {aOverB.toFixed(2)} | B vs A total: {bOverA.toFixed(2)}</div>
      </div>
    </div>
  )
}

function AdRail() {
  return (
    <>
      <div className="sticky top-4 space-y-4">
        {/* Replace with AdSense <ins class="adsbygoogle"> units */}
        <div className="w-full min-h-[250px] rounded-2xl bg-white/5 border border-purple-800/40 flex items-center justify-center text-[11px] text-purple-200/80 shadow-inner">
          Ad slot (e.g., 300×250)
        </div>
        <div className="w-full min-h-[600px] rounded-2xl bg-white/5 border border-purple-800/40 flex items-center justify-center text-[11px] text-purple-200/80 shadow-inner">
          Ad slot (e.g., 300×600)
        </div>
      </div>
      <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4218624684932144"
        crossOrigin="anonymous">
      </script>
    </>
  )
}

export {}
