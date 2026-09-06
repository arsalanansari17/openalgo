import {
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Boxes,
  CandlestickChart,
  ClipboardList,
  Code2,
  Database,
  FileBarChart,
  FileStack,
  FileText,
  FlaskConical,
  Gauge,
  Key,
  Layers,
  LayoutDashboard,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  PieChart,
  Search,
  Settings,
  TrendingUp,
  User,
  Workflow,
  Wrench,
  Zap,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** Served by Flask (not a React route): render as a full-page link. */
  external?: boolean
  /**
   * Sub-items shown in a dropdown instead of navigating directly on click
   * (fork-only "Reports" grouping - see openalgo's SKYSHIELD_PATCHES.md).
   * `href` is still required above even when `children` is set, so every
   * item keeps a single consistent shape for isActiveRoute/tests - it is
   * simply never rendered as a direct link when children are present.
   */
  children?: NavItem[]
}

// Main navigation items shown in desktop navbar
export const navItems: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/orderbook', label: 'Orderbook', icon: ClipboardList },
  { href: '/positions', label: 'Positions', icon: TrendingUp },
  { href: '/trading', label: 'Trading', icon: CandlestickChart },
  { href: '/platforms', label: 'Platforms', icon: Layers },
  { href: '/strategy', label: 'Strategies', icon: Boxes },
  { href: '/logs', label: 'Logs', icon: FileBarChart },
  { href: '/tools', label: 'Tools', icon: Wrench },
  // Fork-only (SKYSHIELD_PATCHES.md): a dropdown grouping report-style
  // pages, mirroring Zerodha Console's own "Reports" menu (Tradebook, P&L,
  // ...). Tradebook moved here from its own top-level slot; P&L is the new
  // consolidated multi-day P&L report. href is a placeholder - clicking the
  // trigger opens the dropdown rather than navigating to /reports directly.
  {
    href: '/reports',
    label: 'Reports',
    icon: BarChart3,
    children: [
      { href: '/tradebook', label: 'Tradebook', icon: FileText },
      { href: '/pnl-history', label: 'P&L', icon: PieChart },
    ],
  },
]

// Items shown in mobile bottom navigation
export const bottomNavItems: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/orderbook', label: 'Orderbook', icon: ClipboardList },
  { href: '/tradebook', label: 'Tradebook', icon: FileText },
  { href: '/positions', label: 'Positions', icon: TrendingUp },
]

// Paths in bottom nav (for filtering mobile sheet items)
const bottomNavPaths = bottomNavItems.map((item) => item.href)

// Secondary items for mobile sheet (items not in bottom nav). A group with
// children (e.g. Reports) is flattened into its children rather than shown
// as its own entry - the mobile sheet renders every row as a direct link,
// with no nested-dropdown affordance like the desktop navbar has, so
// linking to a group's own placeholder href would 404.
export const mobileSheetItems: NavItem[] = navItems
  .flatMap((item) => item.children ?? [item])
  .filter((item) => !bottomNavPaths.includes(item.href))

// Profile dropdown menu items
export const profileMenuItems: NavItem[] = [
  { href: '/profile', label: 'Profile', icon: User },
  { href: '/apikey', label: 'API Key', icon: Key },
  // Action Center stays immediately after API Key. It was moved here out of the
  // main navbar on that understanding and a test pins the adjacency, so a new
  // entry goes after it rather than between the two.
  { href: '/action-center', label: 'Action Center', icon: Bell },
  // Agent Config is NOT here. It lives under /admin with the other
  // configuration surfaces. The chat header carries its own settings control,
  // so a configured /agent still has a route back to its settings without this
  // menu holding one.
  { href: '/agent', label: 'Agent', icon: Bot },
  { href: '/master-contract', label: 'Master Contract', icon: FileStack },
  { href: '/telegram', label: 'Telegram Bot', icon: MessageSquare },
  { href: '/whatsapp', label: 'WhatsApp Bot', icon: MessageCircle },
  { href: '/holdings', label: 'Holdings', icon: ClipboardList },
  { href: '/flow', label: 'Flow Editor', icon: Workflow },
  { href: '/scalping', label: 'Scalping', icon: Zap },
  { href: '/python', label: 'Python Strategies', icon: Code2 },
  { href: '/pnl-tracker', label: 'PnL Tracker', icon: BarChart3 },
  { href: '/historify', label: 'Historify', icon: Database },
  { href: '/search/token', label: 'Search', icon: Search },
  { href: '/sandbox', label: 'Sandbox', icon: FlaskConical },
  { href: '/leverage', label: 'Leverage', icon: Gauge },
  { href: '/admin', label: 'Admin', icon: Settings },
]

// External links
export const externalLinks = {
  docs: { href: 'https://docs.openalgo.in', label: 'Docs', icon: BookOpen },
}

// Shared utility to check if a route is active.
// Every nav item is a leaf route, so an exact match is all that is needed.
export function isActiveRoute(pathname: string, href: string): boolean {
  return pathname === href
}
