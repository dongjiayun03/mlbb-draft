// MLBB Draft Counter — Next.js / React single-file page
// ------------------------------------------------------
// CSV auto-load only (no manual upload). Suggestions update live as picks are typed.

'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Users2, Swords, Shield, RefreshCcw, Link as LinkIcon, Sparkles, Trash2 } from 'lucide-react'

import type { SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient | null = null;
// dynamic import keeps bundle lean and avoids ESM/require lint
(async () => {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (url && key) supabase = createClient(url, key);
  } catch {
    // ignore: realtime is optional
  }
})();

type MatchupScore = { my_hero: string; enemy_hero: string; score: number }
type Assignment = Record<string, { hero: string; score: number } | null>
type LanesMap = Map<string, string>; // lower(hero) -> lane

function parseCSV(text: string): MatchupScore[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!lines.length) return []

  const header = lines[0].split(',').map(h => h.trim().toLowerCase())
  const iMy = header.indexOf('my_hero')
  const iEn = header.indexOf('enemy_hero')
  const iSc = header.indexOf('score')
  if (iMy < 0 || iEn < 0 || iSc < 0) return []

  const rows: MatchupScore[] = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 3) continue
    const myh = parts[iMy]?.trim()
    const enh = parts[iEn]?.trim()
    const sc = Number(parts[iSc])
    if (!myh || !enh || Number.isNaN(sc)) continue
    rows.push({ my_hero: myh, enemy_hero: enh, score: sc })
  }
  return rows
}

function normalizeLane(s: string): string {
  const x = s.trim().toLowerCase();
  if (!x) return "";
  if (["gold", "goldlane", "gold lane", "gold-lane", "gld"].includes(x)) return "Gold";
  if (["exp", "explane", "exp lane", "exp-lane"].includes(x)) return "EXP";
  if (["mid", "midlane", "mid lane", "mid-lane", "middle"].includes(x)) return "Mid";
  if (["jg", "jungle", "jungler"].includes(x)) return "Jungle";
  if (["roam", "support", "tank roam", "roamer"].includes(x)) return "Roam";
  return s.charAt(0).toUpperCase() + s.slice(1); // fallback Title Case
}


// lane-aware greedy suggestions (kept for the existing suggestions panel)
function greedySuggest(
  rows: MatchupScore[],
  enemies: string[],
  k = 5,
  lanes?: Map<string, string>
) {
  const enemyMap = new Map<string, string>();
  for (const e of enemies) {
    const t = e.trim();
    if (t) enemyMap.set(t.toLowerCase(), t);
  }

  const remaining = new Set(enemyMap.keys());
  const usedHeroes = new Set<string>();
  const usedLanes = new Set<string>();

  const candidates: { score: number; my: string; enLower: string; enOrig: string; lane: string }[] = [];
  for (const r of rows) {
    const enLower = r.enemy_hero.toLowerCase();
    if (!remaining.has(enLower)) continue;
    const laneRaw = lanes?.get(r.my_hero.toLowerCase()) || "";
    const lane = normalizeLane(laneRaw);
    if (!lane || !["Gold", "EXP", "Mid", "Jungle", "Roam"].includes(lane)) continue;
    candidates.push({ score: r.score, my: r.my_hero, enLower, enOrig: enemyMap.get(enLower)!, lane });
  }

  candidates.sort((a, b) => b.score - a.score);

  const chosen: string[] = [];
  const assignment: Assignment = Object.fromEntries([...enemyMap.values()].map(e => [e, null]));
  let total = 0;

  while (remaining.size && chosen.length < k && candidates.length) {
    const c = candidates.shift()!;
    if (
      c &&
      remaining.has(c.enLower) &&
      !usedHeroes.has(c.my) &&
      !usedLanes.has(c.lane)
    ) {
      remaining.delete(c.enLower);
      usedHeroes.add(c.my);
      usedLanes.add(c.lane);
      chosen.push(c.my);
      assignment[c.enOrig] = { hero: c.my, score: c.score };
      total += c.score;
      for (let i = candidates.length - 1; i >= 0; i--) {
        const x = candidates[i];
        if (x.my === c.my || x.enLower === c.enLower || x.lane === c.lane) candidates.splice(i, 1);
      }
    }
  }
  return { chosen: [...new Set(chosen)], assignment, total };
}

// --- NEW: utilities to estimate win chance for fixed teams ---

function buildScoreMap(rows: MatchupScore[]) {
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.my_hero.toLowerCase()}@@${r.enemy_hero.toLowerCase()}`, r.score);
  }
  return map;
}

function pairScore(scoreMap: Map<string, number>, my: string, en: string) {
  return scoreMap.get(`${my.toLowerCase()}@@${en.toLowerCase()}`) ?? 0;
}

function logistic(x: number, k = 0.35, x0 = 6) {
  // k = slope, x0 = midpoint (tune these if you want more/less sensitivity)
  return 1 / (1 + Math.exp(-k * (x - x0)));
}

function computeWinAgainst(rows: MatchupScore[], teamA: string[], teamB: string[]) {
  const A = teamA.map(h => h.trim()).filter(Boolean);
  const B = teamB.map(h => h.trim()).filter(Boolean);
  if (A.length === 0 || B.length === 0) return null;

  const scoreMap = buildScoreMap(rows);

  // Exact best pairing by brute force (≤ 5! = 120) — small and fast.
  const allies = [...A];
  const enemies = [...B];

  function* permute(arr: number[]): any {
    const a = arr.slice();
    const c = Array(a.length).fill(0);
    yield a.slice();
    let i = 0;
    while (i < a.length) {
      if (c[i] < i) {
        if (i % 2 === 0) [a[0], a[i]] = [a[i], a[0]];
        else [a[c[i]], a[i]] = [a[i], a[c[i]]];
        c[i]++;
        i = 0;
        yield a.slice();
      } else {
        c[i] = 0; i++;
      }
    }
  }

  const len = Math.min(allies.length, enemies.length, 5);
  const idx = [...Array(len).keys()];
  let bestTotal = -Infinity;
  let bestPairs: { my: string; enemy: string; score: number }[] = [];

  for (const p of permute(idx)) {
    let total = 0;
    const pairs: { my: string; enemy: string; score: number }[] = [];
    for (let i = 0; i < len; i++) {
      const my = allies[i];
      const en = enemies[p[i]];
      const sc = pairScore(scoreMap, my, en);
      total += sc;
      pairs.push({ my, enemy: en, score: sc });
    }
    if (total > bestTotal) { bestTotal = total; bestPairs = pairs; }
  }

  const winProb = logistic(bestTotal); // 0..1
  return { total: bestTotal, winProb, pairs: bestPairs };
}


const DEFAULT_ROOM = 'public'

type DraftState = {
  room: string
  k: number
  teamA: string[]
  teamB: string[]
  bansA: string[]
  bansB: string[]
}

const emptyState: DraftState = {
  room: DEFAULT_ROOM,
  k: 5,
  teamA: Array(5).fill(''),
  teamB: Array(5).fill(''),
  bansA: Array(5).fill(''),
  bansB: Array(5).fill(''),
}

function useRealtime(room: string, state: DraftState, setState: (fn: (s: DraftState) => DraftState) => void) {
  useEffect(() => {
    if (!supabase) return
    const channel = supabase.channel(`draft:${room}`)
    type StatePayload = { payload?: { state?: DraftState } };
    channel.on('broadcast', { event: 'state' }, (payload: StatePayload) => {
      const next = payload?.payload?.state;
      if (next) setState(() => next);
    });

    channel.subscribe()
    return () => {
      supabase?.removeChannel?.(channel)
    }
  }, [room, setState])

  const broadcast = async (st: DraftState) => {
    if (!supabase) return
    await supabase.channel(`draft:${room}`).send({ type: 'broadcast', event: 'state', payload: { state: st } })
  }
  return broadcast
}

export default function DraftPage() {
  const [rows, setRows] = useState<MatchupScore[]>([]);
  const [state, setState] = useState<DraftState>(emptyState);
  const [roomInput, setRoomInput] = useState<string>(DEFAULT_ROOM);

  const [lanes, setLanes] = useState<LanesMap>(new Map());

  const broadcast = useRealtime(state.room, state, setState);

  const suggestions = useMemo(() => {
    const enemyTeam = state.teamB.filter(Boolean);
    return greedySuggest(rows, enemyTeam, state.k);
  }, [rows, state.teamB, state.k]);

  const winEst = useMemo(() => {
    return computeWinAgainst(rows, state.teamA, state.teamB);
  }, [rows, state.teamA, state.teamB]);


  async function loadLanesCsv() {
    try {
      const res = await fetch("/lanes.csv", { cache: "no-store" });
      if (!res.ok) return; // silently ignore if not present
      const text = await res.text();
      // simple CSV parse: hero,lane (no commas inside names)
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (!lines.length) return;
      const header = lines[0].toLowerCase();
      const iHero = header.split(",").indexOf("hero");
      const iLane = header.split(",").indexOf("lane");
      if (iHero < 0 || iLane < 0) return;

      const m = new Map<string,string>();
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(",");
        if (parts.length < 2) continue;
        const h = (parts[iHero] ?? "").trim();
        const ln = (parts[iLane] ?? "").trim();
        if (!h || !ln) continue;
        m.set(h.toLowerCase(), normalizeLane(ln));
      }
      setLanes(m);
    } catch {}
  }

  async function loadDefaultCounters() {
    try {
      const res = await fetch('/counters.csv', { cache: 'no-store' })
      if (!res.ok) return
      const text = await res.text()
      const parsed = parseCSV(text)
      if (parsed.length) setRows(parsed)
    } catch {}
  }

  useEffect(() => {
    loadDefaultCounters();
    const url = new URL(window.location.href);
    const r = url.searchParams.get('room');
    if (r && r !== state.room) setState(s => ({ ...s, room: r }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



  function applyRoom() {
    setState(s => ({ ...s, room: roomInput || DEFAULT_ROOM }))
  }

  function pushState(st: DraftState) {
    setState(st)
    broadcast?.(st)
  }

  function updatePick(team: 'A' | 'B', idx: number, val: string) {
    const arr = team === 'A' ? [...state.teamA] : [...state.teamB]
    arr[idx] = val
    const st = { ...state, teamA: team === 'A' ? arr : state.teamA, teamB: team === 'B' ? arr : state.teamB }
    pushState(st)
  }

  function updateBan(team: 'A' | 'B', idx: number, val: string) {
    const arr = team === 'A' ? [...state.bansA] : [...state.bansB]
    arr[idx] = val
    const st = { ...state, bansA: team === 'A' ? arr : state.bansA, bansB: team === 'B' ? arr : state.bansB }
    pushState(st)
  }

  function clearAll() {
    pushState({ ...emptyState, room: state.room })
  }

  function copyShareLink() {
    const url = new URL(window.location.href)
    url.searchParams.set('room', state.room)
    navigator.clipboard.writeText(url.toString())
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <header className="flex items-center gap-3 mb-6">
          <Swords className="w-7 h-7" />
          <h1 className="text-2xl font-semibold">MLBB Draft Counter</h1>
          <span className="ml-auto text-xs text-slate-400">Counters auto-loaded from /public/counters.csv</span>
        </header>

        <div className="grid md:grid-cols-2 gap-6 mb-6">
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
            <div className="font-medium mb-2 flex items-center gap-2">
              <Users2 className="w-4 h-4" />Room
            </div>
            <div className="flex gap-2">
              <input
                value={roomInput}
                onChange={e => setRoomInput(e.target.value)}
                placeholder="public"
                className="flex-1 bg-slate-800 rounded-xl px-3 py-2 text-sm outline-none"
              />
              <button
                onClick={applyRoom}
                className="px-3 py-2 bg-slate-800 rounded-xl text-sm border border-slate-700"
              >
                Join
              </button>
              <button
                onClick={copyShareLink}
                className="px-3 py-2 bg-slate-800 rounded-xl text-sm border border-slate-700 flex items-center gap-1"
              >
                <LinkIcon className="w-4 h-4" />Share
              </button>
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
            <div className="font-medium mb-2 flex items-center gap-2">
              <Shield className="w-4 h-4" />Settings
            </div>
            <label className="text-sm">Max picks (K)</label>
            <input
              type="number"
              value={state.k}
              min={1}
              max={5}
              onChange={e => pushState({ ...state, k: Math.max(1, Math.min(5, Number(e.target.value) || 5)) })}
              className="w-24 bg-slate-800 rounded-xl px-3 py-2 text-sm outline-none ml-2"
            />
            <button
              onClick={clearAll}
              className="ml-3 inline-flex items-center gap-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-sm"
            >
              <Trash2 className="w-4 h-4" />Clear
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <TeamBoard
            title="Team A (You)"
            picks={state.teamA}
            bans={state.bansA}
            onPick={(idx, val) => updatePick('A', idx, val)}
            onBan={(idx, val) => updateBan('A', idx, val)}
            color="from-emerald-400/20 to-emerald-400/0"
          />
          <TeamBoard
            title="Team B (Enemy)"
            picks={state.teamB}
            bans={state.bansB}
            onPick={(idx, val) => updatePick('B', idx, val)}
            onBan={(idx, val) => updateBan('B', idx, val)}
            color="from-rose-400/20 to-rose-400/0"
          />
        </div>

        <div className="mt-6 p-5 rounded-2xl bg-slate-900 border border-slate-800">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4" />
            <h2 className="text-lg font-semibold">Suggested Picks vs Team B</h2>
          </div>
          {!rows.length ? (
            <p className="text-sm text-slate-400">Provide /public/counters.csv to enable suggestions.</p>
          ) : (
            <div>
              <p className="text-sm text-slate-300">
                Total counter score: <span className="font-semibold">{suggestions.total.toFixed(2)}</span>
              </p>
              <div className="mt-2">
                <div className="text-sm">
                  <span className="text-slate-400">Best picks (≤ {state.k}):</span>{' '}
                  {suggestions.chosen.length ? suggestions.chosen.join(', ') : '(none)'}
                </div>
                <ul className="mt-2 text-sm grid md:grid-cols-2 gap-2">
                  {Object.keys(suggestions.assignment).map(e => {
                    const a = suggestions.assignment[e]
                    return (
                      <li key={e} className="bg-slate-800/60 border border-slate-700 rounded-xl px-3 py-2">
                        <span className="text-slate-400">vs</span>{' '}
                        <span className="font-medium">{e}</span>: {' '}
                        {a ? (
                          <>
                            <span className="font-semibold">{a.hero}</span>{' '}
                            <span className="text-slate-400">(score +{a.score.toFixed(2)})</span>
                          </>
                        ) : (
                          <em className="text-slate-400">no strong counter found</em>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* New: Win rate estimation for the exact teams */}
        <div className="mt-6 p-5 rounded-2xl bg-slate-900 border border-slate-800">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4" />
            <h2 className="text-lg font-semibold">Win chance (Team A vs Team B)</h2>
          </div>
          {!rows.length ? (
            <p className="text-sm text-slate-400">Counters data not loaded.</p>
          ) : !winEst ? (
            <p className="text-sm text-slate-400">Enter picks for both teams to estimate.</p>
          ) : (
            <div>
              <div className="text-2xl font-bold">
                {(winEst.winProb * 100).toFixed(1)}% <span className="text-sm font-normal text-slate-400">(estimated)</span>
              </div>
              <div className="mt-3 text-sm text-slate-300">Best matchup assignment:</div>
              <ul className="mt-2 text-sm grid md:grid-cols-2 gap-2">
                {winEst.pairs.map((p, i) => (
                  <li key={i} className="bg-slate-800/60 border border-slate-700 rounded-xl px-3 py-2">
                    <span className="font-semibold">{p.my}</span> <span className="text-slate-400">vs</span> <span className="font-medium">{p.enemy}</span> <span className="text-slate-400">(score +{p.score.toFixed(2)})</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-sm text-slate-400">Total score: {winEst.total.toFixed(2)} • Model: logistic(total, k=0.35, mid=6)</div>
            </div>
          )}
        </div>


        <div className="mt-8 text-xs text-slate-500 flex items-center gap-2">
          <RefreshCcw className="w-3 h-3" />Data updates live when both sides are in the same room (if Supabase is configured).
        </div>
      </div>
    </div>
  )
}

function TeamBoard({
  title,
  picks,
  bans,
  onPick,
  onBan,
  color,
}: {
  title: string
  picks: string[]
  bans: string[]
  onPick: (idx: number, v: string) => void
  onBan: (idx: number, v: string) => void
  color: string
}) {
  return (
    <div className={`relative p-5 rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden`}>
      <div className={`absolute inset-0 bg-gradient-to-b ${color} pointer-events-none`} />
      <div className="relative">
        <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Swords className="w-4 h-4" />{title}
        </h3>
        <div className="grid grid-cols-5 gap-2">
          {picks.map((v, i) => (
            <input
              key={i}
              value={v}
              onChange={e => onPick(i, e.target.value)}
              placeholder={`Pick ${i + 1}`}
              className="bg-slate-800 rounded-xl px-3 py-2 text-sm outline-none border border-slate-700"
            />
          ))}
        </div>
        <div className="mt-3 text-sm text-slate-400">Bans (optional)</div>
        <div className="grid grid-cols-5 gap-2 mt-1">
          {bans.map((v, i) => (
            <input
              key={i}
              value={v}
              onChange={e => onBan(i, e.target.value)}
              placeholder={`Ban ${i + 1}`}
              className="bg-slate-800 rounded-xl px-3 py-2 text-sm outline-none border border-slate-700"
            />
          ))}
        </div>
      </div>
    </div>
  )
}