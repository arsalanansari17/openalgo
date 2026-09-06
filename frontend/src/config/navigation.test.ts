import { describe, expect, it } from 'vitest'
import {
  bottomNavItems,
  isActiveRoute,
  mobileSheetItems,
  navItems,
  profileMenuItems,
} from './navigation'

describe('Navigation Config', () => {
  describe('navItems', () => {
    it('contains the expected main navigation items', () => {
      expect(navItems).toHaveLength(9)

      const labels = navItems.map((item) => item.label)
      expect(labels).toContain('Dashboard')
      expect(labels).toContain('Tools')
      expect(labels).toContain('Orderbook')
      expect(labels).toContain('Positions')
      expect(labels).toContain('Platforms')
      expect(labels).toContain('Trading')
      expect(labels).toContain('Strategies')

      // Strategies sits directly after Platforms. Asserting the position, not
      // just its presence, is the point: it is where the user expects to find
      // it, and a later insertion that pushed it elsewhere should fail here.
      expect(labels.indexOf('Strategies')).toBe(labels.indexOf('Platforms') + 1)
    })

    it('all items have required properties', () => {
      navItems.forEach((item) => {
        expect(item).toHaveProperty('href')
        expect(item).toHaveProperty('label')
        expect(item).toHaveProperty('icon')
        expect(item.href).toMatch(/^\//)
        expect(item.label.length).toBeGreaterThan(0)
      })
    })

    // Fork-only (SKYSHIELD_PATCHES.md): Reports is a dropdown, not a direct
    // link - Tradebook moved out of its own top-level slot and into here
    // alongside the new P&L report.
    it('groups Tradebook and P&L under a Reports dropdown', () => {
      const reports = navItems.find((item) => item.label === 'Reports')
      expect(reports).toBeDefined()
      expect(reports?.children?.map((child) => child.label)).toEqual(['Tradebook', 'P&L'])
      expect(navItems.some((item) => item.label === 'Tradebook')).toBe(false)
    })
  })

  describe('bottomNavItems', () => {
    it('contains exactly 4 items for mobile bottom nav', () => {
      expect(bottomNavItems).toHaveLength(4)
    })

    it('has the correct order: Dashboard, Orderbook, Tradebook, Positions', () => {
      const labels = bottomNavItems.map((item) => item.label)
      expect(labels).toEqual(['Dashboard', 'Orderbook', 'Tradebook', 'Positions'])
    })
  })

  describe('mobileSheetItems', () => {
    it('excludes items already in bottomNavItems', () => {
      const bottomPaths = bottomNavItems.map((item) => item.href)
      const sheetPaths = mobileSheetItems.map((item) => item.href)

      sheetPaths.forEach((path) => {
        expect(bottomPaths).not.toContain(path)
      })
    })

    it('contains remaining nav items', () => {
      const sheetLabels = mobileSheetItems.map((item) => item.label)
      expect(sheetLabels).toContain('Trading')
      expect(sheetLabels).toContain('Platforms')
      expect(sheetLabels).toContain('Logs')
    })

    it('flattens the Reports group into its children instead of showing the group itself', () => {
      const sheetLabels = mobileSheetItems.map((item) => item.label)
      // Tradebook is already reachable via the bottom bar, so it's excluded
      // here same as before the Reports grouping existed. P&L is new and
      // has no bottom-bar slot, so the sheet is its only mobile entry point.
      expect(sheetLabels).not.toContain('Reports')
      expect(sheetLabels).not.toContain('Tradebook')
      expect(sheetLabels).toContain('P&L')
    })
  })

  describe('profileMenuItems', () => {
    it('contains profile-related menu items', () => {
      const labels = profileMenuItems.map((item) => item.label)
      expect(labels).toContain('Profile')
      expect(labels).toContain('API Key')
      expect(labels).toContain('Holdings')
      // Action Center moved from the main navbar into the profile dropdown,
      // positioned right after API Key.
      expect(labels).toContain('Action Center')
      expect(labels.indexOf('Action Center')).toBe(labels.indexOf('API Key') + 1)
    })
  })

  describe('isActiveRoute', () => {
    it('returns true for exact matches', () => {
      expect(isActiveRoute('/dashboard', '/dashboard')).toBe(true)
      expect(isActiveRoute('/orderbook', '/orderbook')).toBe(true)
      expect(isActiveRoute('/positions', '/positions')).toBe(true)
    })

    it('returns false for non-matching routes', () => {
      expect(isActiveRoute('/dashboard', '/orderbook')).toBe(false)
      expect(isActiveRoute('/positions', '/holdings')).toBe(false)
    })

    it('does not prefix match', () => {
      // No nav item owns nested pages, so neither a child path nor a longer
      // name that merely starts with the href may light the tab up.
      expect(isActiveRoute('/dashboard/sub', '/dashboard')).toBe(false)
      expect(isActiveRoute('/orderbookextra', '/orderbook')).toBe(false)
    })
  })
})
