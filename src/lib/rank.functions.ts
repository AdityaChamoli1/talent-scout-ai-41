import { createServerFn } from "@tanstack/react-start";

type Candidate = {
  candidate_id: string;
  candidate_name: string;
  skills?: string;
  experience?: string;
  education?: string;
  certifications?: string;
  projects?: string;
  resume_summary?: string;
};

type RankInput = {
  jobDescription: string;
  candidates: Candidate[];
};

const GATEWAY = "https://ai.gateway.lovable.dev/v1/embeddings";
const MODEL = "google/gemini-embedding-001";
const DIMS = 768;
const BATCH = 50;

function profileText(c: Candidate): string {
  return [
    c.candidate_name,
    c.skills && `Skills: ${c.skills}`,
    c.experience && `Experience: ${c.experience}`,
    c.education && `Education: ${c.education}`,
    c.certifications && `Certifications: ${c.certifications}`,
    c.projects && `Projects: ${c.projects}`,
    c.resume_summary,
  ]
    .filter(Boolean)
    .join(". ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const STOP = new Set([
  "the","and","for","with","you","your","our","are","has","have","this","that","from","into","over","per","etc","ability","experience","experiences","work","working","role","team","teams","strong","good","great","plus","must","should","will","year","years","yr","yrs","using","use","used","new","also","including","include","across","within","level","senior","junior","mid","lead","principal","specialist","engineer","developer","scientist","comfortable","ideally","preferred","required","requirements","skills","skill","knowledge","proficient","familiarity","familiar","understanding","exposure","plus","etc","across","end","life","cycle","lifecycle","systems","system","models","model","production","research","deployment","build","built","building","develop","develops","developed","developing","ship","shipped","shipping","own","owning","fullstack","stack",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#./ -]+/g, " ")
    .split(/[\s,;|/]+/)
    .map((t) => t.trim().replace(/^[-.]+|[-.]+$/g, ""))
    .filter((t) => t.length >= 2 && t.length <= 30 && !STOP.has(t) && !/^\d+$/.test(t));
}

function skillTokens(text: string): Set<string> {
  return new Set(tokens(text || ""));
}

function yearsFromExperience(exp: string): number {
  const m = (exp || "").match(/(\d+(?:\.\d+)?)\s*(?:\+)?\s*(?:years?|yrs?)/i);
  return m ? Number(m[1]) : 0;
}

function recommendation(score: number, matched: number, missing: number): string {
  if (score >= 80 && missing <= 2) return "Highly Recommended";
  if (score >= 70) return "Recommended";
  if (score >= 55) return "Consider with reservations";
  return "Not a strong fit";
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function embed(input: string | string[], apiKey: string): Promise<number[][]> {
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
    },
    body: JSON.stringify({ model: MODEL, input, dimensions: DIMS }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("Rate limited by AI gateway. Please retry shortly.");
    if (res.status === 402)
      throw new Error("AI credits exhausted. Add credits to your workspace to continue.");
    throw new Error(`Embedding request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  const out = new Array<number[]>(json.data.length);
  for (const d of json.data) out[d.index] = d.embedding;
  return out;
}

export const rankCandidates = createServerFn({ method: "POST" })
  .inputValidator((data: RankInput) => {
    if (!data || typeof data.jobDescription !== "string" || !data.jobDescription.trim()) {
      throw new Error("Job description is required");
    }
    if (!Array.isArray(data.candidates) || data.candidates.length === 0) {
      throw new Error("At least one candidate is required");
    }
    if (data.candidates.length > 10000) {
      throw new Error("Maximum 10,000 candidates per ranking run");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    const jd = data.jobDescription.replace(/\s+/g, " ").trim().toLowerCase();
    const profiles = data.candidates.map(profileText);

    const [jdVec] = await embed(jd, apiKey);

    const vectors: number[][] = new Array(profiles.length);
    const batches: { start: number; inputs: string[] }[] = [];
    for (let i = 0; i < profiles.length; i += BATCH) {
      batches.push({ start: i, inputs: profiles.slice(i, i + BATCH) });
    }

    // Run up to 4 batches in parallel
    const CONCURRENCY = 4;
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const slice = batches.slice(i, i + CONCURRENCY);
      const results = await Promise.all(slice.map((b) => embed(b.inputs, apiKey)));
      slice.forEach((b, idx) => {
        const vecs = results[idx];
        for (let j = 0; j < vecs.length; j++) vectors[b.start + j] = vecs[j];
      });
    }

    const scored = data.candidates.map((c, i) => {
      const sim = cosine(jdVec, vectors[i]);
      return {
        candidate_id: c.candidate_id,
        candidate_name: c.candidate_name,
        skills: c.skills ?? "",
        experience: c.experience ?? "",
        education: c.education ?? "",
        certifications: c.certifications ?? "",
        resume_summary: c.resume_summary ?? "",
        years: yearsFromExperience(c.experience ?? ""),
        similarity: sim,
        match_score: Math.round(Math.max(0, Math.min(1, sim)) * 1000) / 10,
      };
    });

    // Derive "required skills" from JD by intersecting JD tokens with the
    // union of all candidate skill tokens (curated vocabulary of real skills).
    const allSkillVocab = new Set<string>();
    for (const c of data.candidates) {
      for (const t of skillTokens(c.skills ?? "")) allSkillVocab.add(t);
    }
    const jdTokens = new Set(tokens(jd));
    const requiredSkills = new Set<string>();
    for (const t of jdTokens) if (allSkillVocab.has(t)) requiredSkills.add(t);

    const enriched = scored.map((s) => {
      const cSkills = skillTokens(s.skills);
      const matching: string[] = [];
      const missing: string[] = [];
      for (const req of requiredSkills) {
        if (cSkills.has(req)) matching.push(req);
        else missing.push(req);
      }
      return {
        ...s,
        matching_skills: matching.sort(),
        missing_skills: missing.sort(),
        recommendation: recommendation(s.match_score, matching.length, missing.length),
      };
    });

    enriched.sort((a, b) => b.similarity - a.similarity);
    return enriched.map((s, idx) => ({ ...s, rank: idx + 1 }));
  });

export type RankedCandidate = Awaited<ReturnType<typeof rankCandidates>>[number];