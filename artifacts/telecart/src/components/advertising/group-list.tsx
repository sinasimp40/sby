import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AdvertisingGroup } from "@workspace/api-client-react";

const names = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
/** Prune missing destinations without changing the user's remaining choices. */
export function retainedGroupSelection(groups: Pick<AdvertisingGroup, "id">[], selected: Set<string>) {
  const present = new Set(groups.map(group => group.id));
  if ([...selected].every(id => present.has(id))) return selected;
  return new Set([...selected].filter(id => present.has(id)));
}

export function filteredGroups(groups: AdvertisingGroup[], status: string, search: string) {
  const query = search.trim().toLowerCase();
  return groups.filter(group => (status === "all" || group.status === status) &&
    (!query || `${group.title} ${group.target} ${group.chatId ?? ""}`.toLowerCase().includes(query)));
}

/** Bulk actions must never include selections hidden by the current filters. */
export function selectedGroupIdsInView(groups: Pick<AdvertisingGroup, "id">[], selected: Set<string>) {
  return groups.filter(group => selected.has(group.id)).map(group => group.id);
}

export function selectGroupsInView(groups: Pick<AdvertisingGroup, "id">[], selected: Set<string>, checked: boolean) {
  const next = new Set(selected);
  groups.forEach(group => checked ? next.add(group.id) : next.delete(group.id));
  return next;
}

export function snapshotGroupRemoval(groups: AdvertisingGroup[], selected: Set<string>) {
  return groups.filter(group => selected.has(group.id)).map(({ id, title, target }) => ({ id, title, target }));
}

export function alphabeticalGroups(groups: AdvertisingGroup[]) {
  return [...groups].sort((a, b) =>
    names.compare((a.title || a.target).trim(), (b.title || b.target).trim()) ||
    names.compare(a.target, b.target) || a.id.localeCompare(b.id));
}

export function groupListViewportHeight(list: HTMLUListElement) {
  const first = list.children[0];
  const tenth = list.children[9];
  // Both rows move together when scrolled. Measuring against the container
  // instead subtracts scrollTop and feeds a shrinking height back into the
  // ResizeObserver. Include the list's two 1px borders.
  return list.children.length > 10 && first && tenth
    ? Math.ceil(tenth.getBoundingClientRect().bottom - first.getBoundingClientRect().top) + 2
    : undefined;
}

/** Measure actual row heights so notes and narrow layouts still show ten rows. */
export function ScrollableGroupList({ children, count }: { children: ReactNode; count: number }) {
  const ref = useRef<HTMLUListElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list || count <= 10) { setHeight(undefined); return; }
    const measure = () => {
      setHeight(groupListViewportHeight(list));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    Array.from(list.children).slice(0, 10).forEach(row => observer.observe(row));
    return () => observer.disconnect();
  }, [children, count]);
  return <ul ref={ref} className="shrink-0 divide-y overflow-y-auto rounded-lg border [scrollbar-gutter:stable]" style={{ height: count > 10 ? height : undefined }}
    tabIndex={0} aria-label="Groups in alphabetical order" data-testid="list-advertising-groups">{children}</ul>;
}
