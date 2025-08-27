// Replaced existing loadDefaultCounters() to switch to live counter

import { NextResponse } from "next/server";

// Very small HTML scraper (no extra deps).
function extractText(html: string, regex: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

export const revalidate = 0; // don't cache between requests

export async function GET() {
  try {
    // Fetch the official rank page
    const res = await fetch("https://www.mobilelegends.com/rank", {
      // Important: server-side fetch avoids browser CORS
      headers: { "user-agent": "Mozilla/5.0 MLBB-DraftBot" },
      cache: "no-store",
    });
    const html = await res.text();

    // --- NOTE ---
    // The site renders dynamically, but the HTML often contains serialized JSON
    // or visible text blocks for "RANKING", "PICK RATE", "WIN RATE", "BAN RATE" and "COUNTER HERO".
    // We'll try two strategies:
    //   (1) Extract from embedded JSON (common pattern: window.__NUXT__/__NEXT_DATA__ or plain arrays)
    //   (2) Fallback to a naive text scrape for "COUNTER HERO" lines if present.

    // Try #1: look for JSON arrays of heroes; adjust these patterns as needed if they change
    let pairs: { my_hero: string; enemy_hero: string; score: number }[] = [];

    // Quick-and-safe fallback #2:
    // Find repeated blocks like: "COUNTER HERO ... 1st <HeroA> 2nd <HeroB> 3rd <HeroC> ..."
    // Then associate them with the current hero name seen earlier in the block.
    // This is deliberately permissive; you can tighten once you see the exact HTML.
    const heroBlocks = html.split(/HERO[\s\S]*?PICK RATE/gi); // rough split around hero sections
    for (const block of heroBlocks) {
      // hero name: capture a word-ish title case near the start (tweak this if needed)
      const heroMatch = /([A-Z][A-Za-z' -]{2,})[\s\S]{0,80}?WIN RATE/i.exec(block);
      if (!heroMatch) continue;
      const targetHero = heroMatch[1].trim();

      // counter heroes list (top N)
      // example text pattern: "COUNTER HERO. 1st. <Name>. 2nd. <Name>. 3rd..."
      const counters = extractText(
        block,
        /(?:1st|2nd|3rd|4th|5th)\s*\.?\s*([A-Z][A-Za-z' -]{2,})/g
      );

      // Emit pairs: counter beats target
      for (const counter of counters) {
        pairs.push({ my_hero: counter, enemy_hero: targetHero, score: 3 });
      }
    }

    // De-dup (keep max score)
    const key = (a: { my_hero: string; enemy_hero: string }) =>
      `${a.my_hero}@@${a.enemy_hero}`;
    const best = new Map<string, number>();
    for (const p of pairs) {
      const k = key(p);
      best.set(k, Math.max(best.get(k) ?? -Infinity, p.score));
    }
    const dedup = [...best.entries()].map(([k, v]) => {
      const [my_hero, enemy_hero] = k.split("@@");
      return { my_hero, enemy_hero, score: v };
    });

    return NextResponse.json({ ok: true, rows: dedup });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e) },
      { status: 500 }
    );
  }
}
