import type { GetServerSideProps } from "next";
import Link from "next/link";
import { listThreadIds, loadThreadMeta } from "../lib/data";
import type { ThreadMeta } from "../lib/types";

interface IndexProps {
  threads: { id: string; meta: ThreadMeta | null }[];
}

export const getServerSideProps: GetServerSideProps<IndexProps> = async () => {
  const ids = await listThreadIds();
  const threads: { id: string; meta: ThreadMeta | null }[] = [];

  for (const id of ids) {
    const meta = await loadThreadMeta(id);
    threads.push({ id, meta });
  }

  return { props: { threads } };
};

export default function IndexPage({ threads }: IndexProps) {
  return (
    <div className="layout">
      <header className="layout-header">
        <h1>LiLF95Catch Viewer</h1>
        <p>Browse locally scraped F95Zone threads.</p>
      </header>

      {threads.length === 0 ? (
        <p>No threads found in data directory.</p>
      ) : (
        <ul>
          {threads.map(({ id, meta }) => (
            <li key={id}>
              <Link href={`/threads/${id}`}>
                {meta?.title ?? `Thread ${id}`}
              </Link>
              {meta?.last_page_known != null && (
                <span className="badge" style={{ marginLeft: "0.5rem" }}>
                  pages: {meta.last_page_known}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

