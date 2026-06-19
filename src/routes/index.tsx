import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { useServerFn } from "@tanstack/react-start";
import { rankCandidates, type RankedCandidate } from "@/lib/rank.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Intelligent Candidate Discovery" },
      {
        name: "description",
        content:
          "AI-powered candidate ranking. Match resumes to a job description with NLP embeddings and cosine similarity.",
      },
      { property: "og:title", content: "Intelligent Candidate Discovery" },
      {
        property: "og:description",
        content:
          "Rank thousands of candidates against any job description using AI embeddings.",
      },
    ],
  }),
  component: Dashboard,
});

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

const SAMPLE_JD = `Looking for a Senior Data Scientist with strong Python, Machine Learning, SQL, NLP, Statistics and Cloud (AWS/GCP) experience. Must have shipped production ML systems, ideally including NLP or recommender models. Comfortable owning the full lifecycle from research to deployment.`;

function normalizeRow(row: Record<string, unknown>, idx: number): Candidate {
  const get = (k: string) => {
    const key = Object.keys(row).find((rk) => rk.toLowerCase().trim() === k);
    return key ? String(row[key] ?? "").trim() : "";
  };
  return {
    candidate_id: get("candidate_id") || `C${String(idx + 1).padStart(4, "0")}`,
    candidate_name: get("candidate_name") || get("name") || `Candidate ${idx + 1}`,
    skills: get("skills"),
    experience: get("experience"),
    education: get("education"),
    certifications: get("certifications"),
    projects: get("projects"),
    resume_summary: get("resume_summary") || get("summary"),
  };
}

function Dashboard() {
  const rank = useServerFn(rankCandidates);
  const [jd, setJd] = useState(SAMPLE_JD);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [results, setResults] = useState<RankedCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [topN, setTopN] = useState<number>(0); // 0 = all
  const [minScore, setMinScore] = useState(0);
  const [expFilter, setExpFilter] = useState<string>("any");
  const [eduFilter, setEduFilter] = useState<string>("any");
  const [skillFilter, setSkillFilter] = useState<string>("any");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File) {
    setError(null);
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext === "csv") {
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => {
          setCandidates(res.data.map(normalizeRow));
        },
        error: (e) => setError(e.message),
      });
    } else if (ext === "xlsx" || ext === "xls") {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target?.result, { type: "binary" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
          setCandidates(rows.map(normalizeRow));
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to parse file");
        }
      };
      reader.readAsBinaryString(file);
    } else {
      setError("Unsupported file. Use .csv, .xlsx or .xls");
    }
  }

  async function loadSample() {
    setError(null);
    const res = await fetch("/sample-candidates.csv");
    const text = await res.text();
    const parsed = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
    });
    setCandidates(parsed.data.map(normalizeRow));
  }

  async function runRanking() {
    setError(null);
    if (!jd.trim()) return setError("Enter a job description first.");
    if (candidates.length === 0) return setError("Upload candidate data first.");
    setLoading(true);
    setResults([]);
    try {
      const data = await rank({ data: { jobDescription: jd, candidates } });
      setResults(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ranking failed");
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    let r = results;
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(
        (c) =>
          c.candidate_name.toLowerCase().includes(q) ||
          c.candidate_id.toLowerCase().includes(q) ||
          c.skills.toLowerCase().includes(q) ||
          c.education.toLowerCase().includes(q),
      );
    }
    if (minScore > 0) r = r.filter((c) => c.match_score >= minScore);
    if (expFilter !== "any") {
      const [lo, hi] = expFilter.split("-").map(Number);
      r = r.filter((c) => c.years >= lo && c.years <= (hi || 99));
    }
    if (eduFilter !== "any") {
      const q = eduFilter.toLowerCase();
      r = r.filter((c) => c.education.toLowerCase().includes(q));
    }
    if (skillFilter !== "any") {
      const q = skillFilter.toLowerCase();
      r = r.filter((c) => c.skills.toLowerCase().includes(q));
    }
    if (topN > 0) r = r.slice(0, topN);
    return r;
  }, [results, search, topN, minScore, expFilter, eduFilter, skillFilter]);

  // Reset page when filters change
  useMemo(() => {
    setPage(1);
  }, [search, topN, minScore, expFilter, eduFilter, skillFilter, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  // Build filter option lists from results
  const educationOptions = useMemo(() => {
    const opts = new Set<string>();
    for (const r of results) {
      const e = r.education.trim();
      if (!e) continue;
      if (/ph\.?d/i.test(e)) opts.add("Ph.D");
      else if (/m\.?(s|sc|ba|tech|e\b)|master/i.test(e)) opts.add("Masters");
      else if (/b\.?(s|sc|tech|e\b|com|a\b)|bachelor/i.test(e)) opts.add("Bachelors");
      else if (/mba/i.test(e)) opts.add("MBA");
    }
    return Array.from(opts).sort();
  }, [results]);

  const skillOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of results) {
      for (const s of r.matching_skills) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([s]) => s);
  }, [results]);

  const stats = useMemo(() => {
    const total = candidates.length;
    const processed = results.length;
    const top = results.filter((r) => r.match_score >= 70).length;
    const top80 = results.filter((r) => r.match_score >= 80).length;
    const highest = results.length > 0 ? results[0].match_score : 0;
    const avg =
      results.length > 0
        ? Math.round(
            (results.reduce((s, r) => s + r.match_score, 0) / results.length) * 10,
          ) / 10
        : 0;
    return { total, processed, top, top80, avg, highest };
  }, [candidates, results]);

  const topCandidate = results[0];

  function exportCSV() {
    const csv = Papa.unparse(
      filtered.map((r) => ({
        Rank: r.rank,
        "Candidate ID": r.candidate_id,
        "Candidate Name": r.candidate_name,
        "Match Score (%)": r.match_score,
        Similarity: r.similarity.toFixed(4),
        Skills: r.skills,
        Experience: r.experience,
        Education: r.education,
        "Matching Skills": r.matching_skills.join(", "),
        "Missing Skills": r.missing_skills.join(", "),
        Recommendation: r.recommendation,
      })),
    );
    downloadBlob(csv, "ranked-candidates.csv", "text/csv");
  }

  function exportXLSX() {
    const ws = XLSX.utils.json_to_sheet(
      filtered.map((r) => ({
        Rank: r.rank,
        "Candidate ID": r.candidate_id,
        "Candidate Name": r.candidate_name,
        "Match Score (%)": r.match_score,
        Similarity: Number(r.similarity.toFixed(4)),
        Skills: r.skills,
        Experience: r.experience,
        Education: r.education,
        "Matching Skills": r.matching_skills.join(", "),
        "Missing Skills": r.missing_skills.join(", "),
        Recommendation: r.recommendation,
      })),
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Rankings");
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    downloadBlob(
      new Blob([out]),
      "ranked-candidates.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="mx-auto max-w-7xl px-6 py-10 space-y-10">
        <section>
          <h1 className="text-3xl font-semibold tracking-tight">Recruiter Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Match candidates to any job description with AI semantic similarity.
          </p>
          <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Total Candidates" value={stats.total} />
            <StatCard label="Ranked" value={stats.processed} />
            <StatCard label="Avg Match" value={`${stats.avg}%`} />
            <StatCard label="Highest" value={`${stats.highest}%`} accent />
            <StatCard label="≥ 70% Match" value={stats.top} />
            <StatCard label="≥ 80% Match" value={stats.top80} />
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <Card title="1. Job Description">
            <textarea
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              rows={10}
              placeholder="Paste the role requirements, must-have skills, responsibilities…"
              className="w-full resize-y rounded-lg border border-border bg-input/40 p-4 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>{jd.length} characters</span>
              <button
                onClick={() => setJd(SAMPLE_JD)}
                className="rounded-md px-2 py-1 hover:text-foreground"
              >
                Use sample JD
              </button>
            </div>
          </Card>

          <Card title="2. Candidate Data">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
              className="rounded-lg border border-dashed border-border bg-input/20 p-8 text-center"
            >
              <p className="text-sm text-muted-foreground">
                Drop a CSV or XLSX here, or
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-medium hover:bg-secondary/70"
                >
                  Browse file
                </button>
                <button
                  onClick={loadSample}
                  className="rounded-md px-3 py-1.5 text-sm text-accent hover:underline"
                >
                  Load sample dataset
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              <p className="mt-4 text-xs text-muted-foreground">
                Columns: candidate_id, candidate_name, skills, experience, education,
                certifications, projects, resume_summary
              </p>
            </div>
            {candidates.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                Loaded <span className="text-foreground">{candidates.length}</span>{" "}
                candidates.
              </p>
            )}
          </Card>
        </section>

        <section className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">3. Generate Ranking</h2>
            <p className="text-sm text-muted-foreground">
              Embeds the JD and each candidate, then sorts by cosine similarity.
            </p>
          </div>
          <button
            onClick={runRanking}
            disabled={loading}
            className="rounded-lg px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-glow)] transition-opacity disabled:opacity-50"
            style={{ background: "var(--gradient-primary)" }}
          >
            {loading ? "Ranking candidates…" : "Run AI Ranking"}
          </button>
        </section>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
            {error}
          </div>
        )}

        {results.length > 0 && topCandidate && (
          <TopCandidateCard c={topCandidate} />
        )}

        {results.length > 0 && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Ranked Candidates</h2>
                <p className="text-xs text-muted-foreground">
                  {filtered.length} of {results.length} candidates after filters
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={exportCSV}
                  className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm hover:bg-secondary/70"
                >
                  Export CSV
                </button>
                <button
                  onClick={exportXLSX}
                  className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm hover:bg-secondary/70"
                >
                  Export XLSX
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-card/60 p-3 md:grid-cols-6">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, skills, education…"
                className="col-span-2 rounded-md border border-border bg-input/40 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <select
                value={topN}
                onChange={(e) => setTopN(Number(e.target.value))}
                className="rounded-md border border-border bg-input/40 px-3 py-1.5 text-sm"
              >
                <option value={0}>All ranks</option>
                <option value={10}>Top 10</option>
                <option value={25}>Top 25</option>
                <option value={50}>Top 50</option>
                <option value={100}>Top 100</option>
              </select>
              <select
                value={minScore}
                onChange={(e) => setMinScore(Number(e.target.value))}
                className="rounded-md border border-border bg-input/40 px-3 py-1.5 text-sm"
              >
                <option value={0}>Any score</option>
                <option value={50}>≥ 50%</option>
                <option value={70}>≥ 70%</option>
                <option value={80}>≥ 80%</option>
              </select>
              <select
                value={expFilter}
                onChange={(e) => setExpFilter(e.target.value)}
                className="rounded-md border border-border bg-input/40 px-3 py-1.5 text-sm"
              >
                <option value="any">Any experience</option>
                <option value="0-2">0–2 yrs</option>
                <option value="3-5">3–5 yrs</option>
                <option value="6-9">6–9 yrs</option>
                <option value="10-99">10+ yrs</option>
              </select>
              <select
                value={eduFilter}
                onChange={(e) => setEduFilter(e.target.value)}
                className="rounded-md border border-border bg-input/40 px-3 py-1.5 text-sm"
              >
                <option value="any">Any education</option>
                {educationOptions.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
              <select
                value={skillFilter}
                onChange={(e) => setSkillFilter(e.target.value)}
                className="col-span-2 rounded-md border border-border bg-input/40 px-3 py-1.5 text-sm md:col-span-1"
              >
                <option value="any">Any skill</option>
                {skillOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-card/95">
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3 w-16">Rank</th>
                      <th className="px-4 py-3">Candidate</th>
                      <th className="px-4 py-3">Match</th>
                      <th className="px-4 py-3">Experience</th>
                      <th className="px-4 py-3">Education</th>
                      <th className="px-4 py-3">Skills match</th>
                      <th className="px-4 py-3 w-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((c) => {
                      const isOpen = expandedId === c.candidate_id;
                      return (
                        <>
                          <tr
                            key={c.candidate_id}
                            className="border-b border-border/50 hover:bg-secondary/30 cursor-pointer"
                            onClick={() =>
                              setExpandedId(isOpen ? null : c.candidate_id)
                            }
                          >
                            <td className="px-4 py-3">
                              <RankBadge rank={c.rank} />
                            </td>
                            <td className="px-4 py-3">
                              <div className="font-medium text-foreground">
                                {c.candidate_name}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {c.candidate_id}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <ScoreBar score={c.match_score} />
                            </td>
                            <td className="px-4 py-3 text-muted-foreground max-w-[14rem] truncate">
                              {c.experience || "—"}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground max-w-[14rem] truncate">
                              {c.education || "—"}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1 text-xs">
                                <span className="rounded-md bg-secondary px-2 py-0.5 text-foreground">
                                  {c.matching_skills.length} match
                                </span>
                                {c.missing_skills.length > 0 && (
                                  <span className="rounded-md border border-border px-2 py-0.5 text-muted-foreground">
                                    {c.missing_skills.length} missing
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              <span
                                className={`inline-block transition-transform ${isOpen ? "rotate-90" : ""}`}
                              >
                                ›
                              </span>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-secondary/20">
                              <td colSpan={7} className="px-6 py-4">
                                <CandidateDetail c={c} />
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                    {paged.length === 0 && (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-4 py-10 text-center text-sm text-muted-foreground"
                        >
                          No candidates match the current filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card/60 px-4 py-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span>Rows per page</span>
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    className="rounded-md border border-border bg-input/40 px-2 py-1 text-xs"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="rounded-md border border-border px-2 py-1 disabled:opacity-40 hover:bg-secondary/60"
                  >
                    ‹ Prev
                  </button>
                  <span>
                    Page {page} / {pageCount}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    disabled={page >= pageCount}
                    className="rounded-md border border-border px-2 py-1 disabled:opacity-40 hover:bg-secondary/60"
                  >
                    Next ›
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}
      </main>
      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        Intelligent Candidate Discovery · Powered by Lovable AI embeddings
      </footer>
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-border bg-card/40 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <div
            className="h-9 w-9 rounded-lg"
            style={{ background: "var(--gradient-primary)" }}
          />
          <div>
            <div className="text-sm font-semibold tracking-tight">
              Intelligent Candidate Discovery
            </div>
            <div className="text-xs text-muted-foreground">
              AI-powered resume ranking
            </div>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">v1.0 · NLP semantic match</div>
      </div>
    </header>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div
      className="rounded-xl border border-border bg-card p-4"
      style={accent ? { background: "var(--gradient-surface)" } : undefined}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className="mt-2 text-2xl font-semibold"
        style={accent ? { color: "var(--accent)" } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const top = rank <= 3;
  return (
    <span
      className="inline-flex h-7 w-9 items-center justify-center rounded-md text-xs font-semibold"
      style={
        top
          ? {
              background: "var(--gradient-primary)",
              color: "var(--primary-foreground)",
            }
          : { background: "var(--secondary)", color: "var(--secondary-foreground)" }
      }
    >
      #{rank}
    </span>
  );
}

function ScoreBar({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full"
          style={{
            width: `${clamped}%`,
            background: "var(--gradient-primary)",
          }}
        />
      </div>
      <span className="w-12 text-right text-xs font-medium tabular-nums">
        {score.toFixed(1)}%
      </span>
    </div>
  );
}

function downloadBlob(data: string | Blob, filename: string, mime: string) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
