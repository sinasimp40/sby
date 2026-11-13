import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getAdvertisingActivity, useGetAdvertisingActivity,
  type AdvertisingAccountRun, type AdvertisingActivityPage, type AdvertisingWorkspace,
  type GetAdvertisingActivityParams,
} from "@workspace/api-client-react";
import { Activity, Filter, Loader2 } from "lucide-react";
import { Panel, EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/advertising-panels";
import { dateTime } from "@/lib/format";
import { appendPostingPage, postingDayRange, postingHeadChanged, refreshLoadedPosts } from "./posting-history-state";

type Range = Pick<GetAdvertisingActivityParams, "from" | "to"> | undefined;

export function RunsPanel(_props: { ws: AdvertisingWorkspace }) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [date, setDate] = useState("");
  const range = useMemo(() => postingDayRange(date), [date]);
  return <Panel title="Posting activity">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">Scroll for more posts · logs kept for 5 days</span>
      <Button size="sm" variant="outline" onClick={() => setFiltersOpen(v => !v)} aria-expanded={filtersOpen} data-testid="button-activity-filter">
        <Filter className="mr-2 h-3.5 w-3.5" />{date ? `Date: ${date}` : "Filter by date"}
      </Button>
    </div>
    {filtersOpen && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border p-3">
      <label htmlFor="activity-date" className="text-xs">Posting date</label>
      <Input id="activity-date" type="date" value={date} onChange={e => setDate(e.target.value)} className="w-auto" data-testid="input-activity-date" />
      {date && <Button variant="ghost" size="sm" onClick={() => setDate("")} data-testid="button-clear-activity-date">Clear</Button>}
      <span className="text-xs text-muted-foreground">Your local time · last 5 days only</span>
    </div>}
    <PostingHistory key={date || "all"} range={range} filtered={!!date} />
  </Panel>;
}

function PostingHistory({ range, filtered }: { range: Range; filtered: boolean }) {
  const head = useGetAdvertisingActivity(range, { query: { refetchInterval: 5000, retry: false } });
  const [runs, setRuns] = useState<AdvertisingAccountRun[]>(() => head.data?.items ?? []);
  const rows = useRef(runs);
  const [next, setNext] = useState<string | null>(head.data?.nextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const request = useRef<AbortController | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);

  const updateRows = useCallback((items: AdvertisingAccountRun[]) => {
    const root = region.current;
    if (root && root.scrollTop > 1) {
      const top = root.getBoundingClientRect().top;
      const visible = Array.from(root.querySelectorAll<HTMLElement>("[data-post-id]"))
        .find(el => el.getBoundingClientRect().bottom > top);
      if (visible) anchor.current = { id: visible.dataset.postId!, top: visible.getBoundingClientRect().top };
    }
    rows.current = items;
    setRuns(items);
  }, []);

  useLayoutEffect(() => {
    if (!anchor.current || !region.current) return;
    const el = region.current.querySelector<HTMLElement>(`[data-post-id="${anchor.current.id}"]`);
    if (el) region.current.scrollTop += el.getBoundingClientRect().top - anchor.current.top;
    anchor.current = null;
  }, [runs]);

  const showLatest = useCallback((page: AdvertisingActivityPage) => {
    request.current?.abort(); request.current = null;
    setLoadingMore(false); setMoreError(false); setNext(page.nextCursor);
    anchor.current = null;
    if (region.current) region.current.scrollTop = 0;
    rows.current = page.items; setRuns(page.items);
  }, []);

  useEffect(() => {
    if (!head.data) return;
    if (!rows.current.length || !head.data.items.length || !region.current || region.current.scrollTop <= 1) {
      // Only replace a loaded tail when the actual head changed, not on every poll.
      if (!rows.current.length || postingHeadChanged(rows.current, head.data.items)) showLatest(head.data);
      else {
        updateRows(refreshLoadedPosts(rows.current, head.data.items, Date.now() - 5 * 86400000));
      }
      return;
    }
    updateRows(refreshLoadedPosts(rows.current, head.data.items, Date.now() - 5 * 86400000));
  }, [head.data, head.dataUpdatedAt, showLatest, updateRows]);

  const loadMore = useCallback(async (retry = false) => {
    if (!next || request.current || (moreError && !retry)) return;
    const controller = new AbortController();
    request.current = controller;
    setLoadingMore(true); setMoreError(false);
    try {
      const page = await getAdvertisingActivity({ ...range, cursor: next }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      updateRows(appendPostingPage(rows.current, page.items));
      setNext(page.nextCursor);
    } catch {
      if (!controller.signal.aborted) setMoreError(true);
    } finally {
      if (request.current === controller) { request.current = null; setLoadingMore(false); }
    }
  }, [next, range, moreError, updateRows]);

  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => {
    if (!sentinel.current || !region.current || !next || moreError || !globalThis.IntersectionObserver) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { root: region.current, rootMargin: "0px 0px 120px 0px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [next, moreError, loadMore]);

  const newer = !!runs.length && !!head.data && postingHeadChanged(runs, head.data.items);
  const uncertain = runs.filter(r => r.status === "uncertain").length;
  const legacy = runs.some(r => r.status === "sent" && !r.note?.startsWith("Verified in selected group: message #"));
  return <>
    {head.isError && <p className="mb-3 text-sm text-destructive" role="alert">
      Could not {runs.length ? "refresh" : "load"} posting activity. <Button size="sm" variant="outline" onClick={() => void head.refetch()}>Retry</Button>
    </p>}
    {newer && <Button className="mb-3" variant="outline" size="sm" data-testid="button-activity-latest" onClick={() => head.data && showLatest(head.data)}>New posts available · Show latest</Button>}
    {legacy && <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">Older “sent” records were not checked by reading the message back from the group. They are not proof the message was visible.</p>}
    {uncertain > 0 && <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="banner-uncertain">{uncertain} uncertain {uncertain === 1 ? "result" : "results"} in loaded history: Telegram may have posted. Those groups are stopped until you check them and start again. No automatic retry.</p>}
    <p className="mb-2 text-xs text-muted-foreground" data-testid="text-run-count">{runs.length} posts loaded</p>
    {head.isPending && !runs.length ? <p className="py-6 text-sm text-muted-foreground" role="status">Loading posts…</p> :
      !runs.length && !head.isError ? <EmptyState icon={Activity} title={filtered ? "No posts on this date" : "No posts yet"} body="Only posting logs from the last five days are available." /> :
      !!runs.length && <div ref={region} tabIndex={0} role="region" aria-label="Scrollable posting activity" aria-busy={loadingMore}
        data-testid="activity-scroll" className="overflow-y-auto overscroll-contain rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ maxHeight: 640, overflowAnchor: "none" }}
        onScroll={e => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) void loadMore(); }}>
        <ul className="divide-y">{runs.map(r => <li key={r.id} data-post-id={r.id} className="min-h-16 p-3" data-testid={`row-run-${r.id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Tag s={r.status === "sent" && !r.note?.startsWith("Verified in selected group: message #") ? "unverified" : r.status} testId={`status-run-${r.id}`} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.target}</span>
            <span className="text-[11px] text-muted-foreground">{dateTime(r.sentAt ?? r.startedAt)}</span>
          </div>
          {r.note && <div className="mt-1 text-xs text-muted-foreground">{r.status === "sent" && !r.note.startsWith("Verified in selected group: message #") ? "Legacy send result; no saved message receipt or group read-back verification." : r.note}</div>}
        </li>)}</ul>
        <div ref={sentinel} className="flex min-h-12 items-center justify-center gap-2 border-t p-2 text-xs text-muted-foreground">
          {loadingMore ? <span className="inline-flex items-center gap-2" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading more posts…</span> :
            moreError ? <><span role="alert">Could not load more posts.</span><Button size="sm" variant="outline" onClick={() => void loadMore(true)} data-testid="button-activity-retry">Retry</Button></> :
            next ? <Button size="sm" variant="ghost" onClick={() => void loadMore()} data-testid="button-activity-more">Load more posts</Button> :
            <span data-testid="activity-history-end">End of {filtered ? "this day’s" : "retained"} posting history</span>}
        </div>
      </div>}
  </>;
}
