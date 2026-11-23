// Supabase Edge Function: import-recipe
// Given a recipe page URL, fetches it and returns the recipe the site publishes
// for search engines (schema.org "Recipe" JSON-LD): title, ingredients, steps.
// Only signed-in users of the app can call it (Supabase checks the login token).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function asArray<T>(x: T | T[] | undefined | null): T[] {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}

function isRecipe(node: any): boolean {
  return asArray(node?.["@type"]).some((t) => String(t).toLowerCase() === "recipe");
}

function findRecipe(node: any, depth = 0): any {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipe(n, depth + 1); if (r) return r; }
    return null;
  }
  if (isRecipe(node)) return node;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const r = findRecipe(node[k], depth + 1);
    if (r) return r;
  }
  return null;
}

const decode = (s: string) =>
  s.replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, " ").trim();

function steps(instr: any): { group: string; text: string }[] {
  const out: { group: string; text: string }[] = [];
  const walk = (n: any, group: string) => {
    if (n == null) return;
    if (typeof n === "string") {
      // Some sites put all steps in one string separated by newlines.
      n.split(/\n+/).map(decode).filter(Boolean).forEach((t) => out.push({ group, text: t }));
      return;
    }
    if (Array.isArray(n)) { n.forEach((x) => walk(x, group)); return; }
    const type = asArray(n["@type"]).map(String);
    if (type.includes("HowToSection")) { walk(n.itemListElement, decode(String(n.name || ""))); return; }
    if (n.text || n.name) { const t = decode(String(n.text || n.name)); if (t) out.push({ group, text: t }); return; }
    if (n.itemListElement) walk(n.itemListElement, group);
  };
  walk(instr, "");
  return out;
}

function minutes(iso: unknown): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(iso || ""));
  if (!m) return 0;
  return (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let url = "";
  try { url = String((await req.json()).url || ""); } catch { /* fallthrough */ }
  let target: URL;
  try { target = new URL(url); } catch { return json({ error: "bad_url" }, 400); }
  if (!/^https?:$/.test(target.protocol)) return json({ error: "bad_url" }, 400);

  let html = "";
  try {
    const res = await fetch(target.href, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return json({ error: "fetch_failed", status: res.status }, 422);
    html = (await res.text()).slice(0, 3_000_000);
  } catch {
    return json({ error: "fetch_failed" }, 422);
  }

  let recipe: any = null;
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try { recipe = findRecipe(JSON.parse(m[1].trim())); } catch { /* skip bad block */ }
    if (recipe) break;
  }
  if (!recipe) return json({ error: "no_recipe" }, 422);

  const image = asArray(recipe.image).map((i: any) => (typeof i === "string" ? i : i?.url)).find(Boolean) || "";
  const yieldTxt = asArray(recipe.recipeYield).map(String).sort((a, b) => b.length - a.length)[0] || "";
  return json({
    title: decode(String(recipe.name || "")),
    summary: decode(String(recipe.description || "")).slice(0, 300),
    servings: decode(yieldTxt),
    totalMinutes: minutes(recipe.totalTime) || minutes(recipe.cookTime) + minutes(recipe.prepTime),
    image: String(image),
    ingredients: asArray(recipe.recipeIngredient).map((s: any) => decode(String(s))).filter(Boolean),
    steps: steps(recipe.recipeInstructions),
    sourceUrl: target.href,
  });
});
