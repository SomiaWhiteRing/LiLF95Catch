import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getInstalledVersion, loadManifest } from "../lib/staticData";
import { DEFAULT_LANG, DEFAULT_THREAD_ID, type Lang, text } from "../lib/i18n";
import type { StaticManifest, StaticThreadEntry } from "../lib/types";

export default function IndexPage() {
  const [lang, setLang] = useState<Lang>(DEFAULT_LANG);
  const t = text[lang];
  const [manifest, setManifest] = useState<StaticManifest | null>(null);
  const [thread, setThread] = useState<StaticThreadEntry | null>(null);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadManifest(), getInstalledVersion()])
      .then(([nextManifest, installed]) => {
        setManifest(nextManifest);
        setThread(nextManifest.threads.find((item) => String(item.thread_id) === DEFAULT_THREAD_ID) ?? nextManifest.threads[0] ?? null);
        setInstalledVersion(installed);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const cached = manifest && installedVersion === manifest.version;
  const generated = useMemo(
    () => manifest ? new Date(manifest.generated_at).toLocaleString(lang === "zh" ? "zh-CN" : "en-US") : "",
    [manifest, lang],
  );

  return (
    <main className="md-app">
      <header className="md-top-app-bar">
        <div>
          <div className="md-overline">Lessons in Love</div>
          <h1>{t.appName}</h1>
        </div>
        <LanguageSwitch lang={lang} setLang={setLang} />
      </header>

      <section className="md-hero">
        <div className="md-hero-content">
          <div className="md-overline">F95Zone Thread 48158</div>
          <h2>{thread?.title ?? "Lessons in Love"}</h2>
          <p>{t.appSubtitle}</p>
          <div className="md-actions">
            <Link className="md-button md-button-contained" href={`/threads/${thread?.thread_id ?? DEFAULT_THREAD_ID}/`}>
              {t.openViewer}
            </Link>
          </div>
        </div>
      </section>

      <section className="md-grid">
        <article className="md-card md-status-card">
          <h3>{t.dataset}</h3>
          {error ? (
            <div className="md-empty">
              <strong>{t.datasetMissing}</strong>
              <code>python -m crawler.lilf95_crawler.cli build-static-viewer-data --out viewer/public/datasets</code>
              <span>{error}</span>
            </div>
          ) : (
            <div className="md-metrics">
              <Metric label={t.dataset} value={manifest?.version ?? "..."} />
              <Metric label={t.posts} value={String(thread?.total_posts ?? 0)} />
              <Metric label={t.generated} value={generated || "..."} />
              <Metric label={cached ? t.cached : t.notCached} value={cached ? "OK" : "-"} />
            </div>
          )}
        </article>
      </section>
    </main>
  );
}

function LanguageSwitch({ lang, setLang }: { lang: Lang; setLang: (lang: Lang) => void }) {
  return (
    <div className="md-segmented" aria-label={text[lang].language}>
      <button className={lang === "zh" ? "active" : ""} onClick={() => setLang("zh")} type="button">
        中文
      </button>
      <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")} type="button">
        EN
      </button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="md-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
