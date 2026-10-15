import type { PropertyType, StatusGroup, ViewType } from '@oriel/shared';
import {
  ArrowUpRight,
  AtSign,
  Calendar,
  CalendarDays,
  ChartNoAxesGantt,
  CircleChevronDown,
  CircleDot,
  ClockArrowUp,
  ClockPlus,
  Hash,
  IdCard,
  Search as SearchIcon,
  LayoutGrid,
  LayoutList,
  Link,
  Paperclip,
  Phone,
  Sigma,
  SquareCheck,
  SquareKanban,
  Table2,
  Tags,
  TextAlignStart,
  Type,
  UserPen,
  UserPlus,
  Users,
  type LucideIcon,
  ChartBar as ChartBarIcon,
  ChartColumn,
  ChartLine,
  ChartPie,
  ClipboardList,
  Hash as HashIcon,
  LayoutDashboard,
  Map as MapIcon,
  MapPin,
  Newspaper,
  ShieldCheck,
  Eye,
} from 'lucide-react';

export const PROPERTY_ICONS: Record<PropertyType, LucideIcon> = {
  title: Type,
  text: TextAlignStart,
  number: Hash,
  select: CircleChevronDown,
  multi_select: Tags,
  status: CircleDot,
  date: Calendar,
  person: Users,
  checkbox: SquareCheck,
  url: Link,
  email: AtSign,
  phone: Phone,
  files: Paperclip,
  relation: ArrowUpRight,
  formula: Sigma,
  created_time: ClockPlus,
  created_by: UserPlus,
  last_edited_time: ClockArrowUp,
  last_edited_by: UserPen,
  unique_id: IdCard,
  rollup: SearchIcon,
  place: MapPin,
  verification: ShieldCheck,
  last_visited: Eye,
};

export const VIEW_ICONS: Record<ViewType, LucideIcon> = {
  table: Table2,
  board: SquareKanban,
  list: LayoutList,
  gallery: LayoutGrid,
  calendar: CalendarDays,
  timeline: ChartNoAxesGantt,
  feed: Newspaper,
  chart_bar: ChartColumn,
  chart_hbar: ChartBarIcon,
  chart_line: ChartLine,
  chart_donut: ChartPie,
  chart_number: HashIcon,
  dashboard: LayoutDashboard,
  map: MapIcon,
  form: ClipboardList,
};

export function PropertyIcon({ type, size = 14 }: { type: PropertyType; size?: number }) {
  const Icon = PROPERTY_ICONS[type];
  return <Icon size={size} strokeWidth={1.8} className="ordb-prop-icon" aria-hidden />;
}

export function ViewIcon({ type, size = 14 }: { type: ViewType; size?: number }) {
  const Icon = VIEW_ICONS[type];
  return <Icon size={size} strokeWidth={1.8} aria-hidden />;
}

/** Small circle showing the progress of a status group (empty, half, full). */
export function StatusDot({ group }: { group: StatusGroup | undefined }) {
  const g = group ?? 'todo';
  return (
    <svg className="ordb-status-dot" data-group={g} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={g === 'todo' ? '2 1.6' : undefined} />
      {g === 'in_progress' && <path d="M5 1 A4 4 0 0 1 5 9 Z" fill="currentColor" />}
      {g === 'done' && <circle cx="5" cy="5" r="4" fill="currentColor" />}
    </svg>
  );
}
