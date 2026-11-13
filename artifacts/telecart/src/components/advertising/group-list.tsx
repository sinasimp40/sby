import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AdvertisingGroup } from "@workspace/api-client-react";

const names = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
export function alphabeticalGroups(groups: AdvertisingGroup[]) {
  return [...groups].sort((a, b) =>
    names.compare((a.title || a.target).trim(), (b.title || b.target).trim()) ||
    names.compare(a.target, b.target) || a.id.localeCompare(b.id));
}

export function groupListViewportHeight(list: HTMLUListElement) {
  const tenth = list.children[9];
  return list.children.length > 10 && tenth
    ? Math.ceil(tenth.getBoundingClientRect().bottom - list.getBoundingClientRect().top) + 1
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
  return <ul ref={ref} className="divide-y overflow-y-auto rounded-lg border" style={{ maxHeight: count > 10 ? height : undefined }}
    tabIndex={0} aria-label="Groups in alphabetical order" data-testid="list-advertising-groups">{children}</ul>;
}
