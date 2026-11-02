import { test, expect } from '@playwright/test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

/**
 * Home folders in the sidebar-less world: the desktop's folder-root icons
 * open folder views, and the create / rename / move / delete actions run
 * against the real disk from the folder view's rows. (The retired sidebar
 * tree's coverage, retargeted: the root icon is the way in, the table rows
 * are the surface the verbs live on.)
 */
test.describe('home folders (desktop icons + folder views)', () => {
  let root: string

  test.beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-root-')))
    mkdirSync(join(root, 'Clients', 'A Corp'), { recursive: true })
    mkdirSync(join(root, 'Clients', 'Contracts'), { recursive: true })
    mkdirSync(join(root, 'Personal'))
    writeFileSync(join(root, 'report.docx'), 'x')
    writeFileSync(join(root, 'notes.md'), '# notes')
    writeFileSync(join(root, 'Clients', 'Contracts', 'deal.md'), '# deal')
  })

  test.afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('opens a root icon, then creates / moves / renames / deletes on disk', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { defaultSaveDir: root },
      videoDir: 'home-folders',
    })
    const { page } = launched
    try {
      // the desktop shows the root's icon; double-click opens its folder view
      const rootIcon = page.locator(`.desktop-icon-item[title="${root}"]`)
      await expect(rootIcon).toBeVisible()
      await rootIcon.dblclick()
      await expect(page.locator('.desktop-surface')).toHaveCount(0)

      // the root view lists its first-level folders and files
      const list = page.locator('.recent-list')
      await expect(list.locator('.folder-item .recent-name', { hasText: 'Clients' })).toBeVisible()
      await expect(list.locator('.folder-item .recent-name', { hasText: 'Personal' })).toBeVisible()
      await expect(list.locator('.recent-name', { hasText: 'report.docx' })).toBeVisible()
      // second-level folders are NOT in the root's own listing
      await expect(list.locator('.recent-name', { hasText: 'Contracts' })).toHaveCount(0)

      // enter Clients → its subfolders and files
      await list.locator('.folder-item', { hasText: 'Clients' }).locator('.recent-name').click()
      await expect(
        list.locator('.folder-item .recent-name', { hasText: 'Contracts' }),
      ).toBeVisible()
      await expect(list.locator('.recent-name', { hasText: 'A Corp' })).toBeVisible()

      // select Contracts → its file
      await list.locator('.folder-item', { hasText: 'Contracts' }).locator('.recent-name').click()
      await expect(page.locator('.recent-list .recent-name', { hasText: 'deal.md' })).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-folders-contracts') })

      // new folder from the folder view toolbar: lands under the open folder
      await page.locator('.folder-heading .folder-new-btn').click()
      const input = page.locator('.recent-list .folder-item .rename-input')
      await input.fill('Drafts')
      await input.press('Enter')
      await expect(
        page.locator('.recent-list .folder-item .recent-name', { hasText: 'Drafts' }),
      ).toBeVisible()
      expect(existsSync(join(root, 'Clients', 'Contracts', 'Drafts'))).toBe(true)

      // move deal.md → Personal through the picker
      const dealRow = page.locator('.recent-row', {
        has: page.locator('.recent-name', { hasText: 'deal.md' }),
      })
      await dealRow.locator('.more-btn').click()
      await page.locator('.row-menu button', { hasText: 'Move to folder' }).click()
      const picker = page.locator('.picker-modal')
      await expect(picker).toBeVisible()
      await picker
        .locator('.picker-row', { has: page.locator('.picker-name', { hasText: 'Personal' }) })
        .click()
      await picker.locator('.btn-primary').click()
      await expect(picker).toHaveCount(0)
      await expect(page.locator('.recent-list .recent-name', { hasText: 'deal.md' })).toHaveCount(0)
      expect(existsSync(join(root, 'Personal', 'deal.md'))).toBe(true)
      expect(existsSync(join(root, 'Clients', 'Contracts', 'deal.md'))).toBe(false)

      // rename Drafts → Final from the sub-folder row menu
      const draftsRow = page.locator('.recent-row', {
        has: page.locator('.recent-name', { hasText: 'Drafts' }),
      })
      await draftsRow.locator('.more-btn').click()
      await page.locator('.folder-menu button', { hasText: 'Rename' }).click()
      const renameInput = page.locator('.recent-list .rename-input')
      await renameInput.fill('Final')
      await renameInput.press('Enter')
      await expect(
        page.locator('.recent-list .folder-item .recent-name', { hasText: 'Final' }),
      ).toBeVisible()
      expect(existsSync(join(root, 'Clients', 'Contracts', 'Final'))).toBe(true)

      // delete Final (confirm dialog → trash)
      const finalRow = page.locator('.recent-row', {
        has: page.locator('.recent-name', { hasText: 'Final' }),
      })
      await finalRow.locator('.more-btn').click()
      await page.locator('.folder-menu button.danger').click()
      await page.locator('.modal .btn-danger').click()
      await expect(page.locator('.recent-list .recent-name', { hasText: 'Final' })).toHaveCount(0)
      expect(existsSync(join(root, 'Clients', 'Contracts', 'Final'))).toBe(false)

      // Personal now lists the moved file, entered from the desktop root icon
      await page.locator('.dock-item[aria-label="Desktop"]').click()
      await rootIcon.dblclick()
      await page
        .locator('.recent-list .folder-item', { hasText: 'Personal' })
        .locator('.recent-name')
        .click()
      await expect(page.locator('.recent-list .recent-name', { hasText: 'deal.md' })).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-folders-personal') })
    } finally {
      await closeAndSaveVideo(launched, 'home-folders')
    }
  })

  test('an added root shows as its own desktop icon and leaves without touching disk', async () => {
    const extra = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-extra-')))
    mkdirSync(join(extra, 'Projects', 'Alpha'), { recursive: true })
    writeFileSync(join(extra, 'Projects', 'plan.md'), '# plan')
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { defaultSaveDir: root, folderRoots: [extra] },
      videoDir: 'home-folders-roots',
    })
    const { page, userDataDir } = launched
    try {
      // two root icons on the desktop, one per roots-list entry (a folder
      // icon's title carries its path)
      const rootIcons = page.locator(
        `.desktop-icon-item[title="${root}"], .desktop-icon-item[title="${extra}"]`,
      )
      await expect(rootIcons).toHaveCount(2)
      await expect(page.locator(`.desktop-icon-item[title="${root}"]`)).toBeVisible()
      const extraIcon = page.locator(`.desktop-icon-item[title="${extra}"]`)
      await expect(extraIcon).toBeVisible()

      // the added root's own contents show in its folder view
      await extraIcon.dblclick()
      await expect(page.locator('.recent-list .recent-name', { hasText: 'plan.md' })).toBeVisible()
      await expect(page.locator('.recent-list .recent-name', { hasText: 'Alpha' })).toBeVisible()

      // edits happen where the folder really is
      await page.locator('.folder-heading .folder-new-btn').click()
      const input = page.locator('.recent-list .folder-item .rename-input')
      await input.fill('Beta')
      await input.press('Enter')
      await expect(
        page.locator('.recent-list .folder-item .recent-name', { hasText: 'Beta' }),
      ).toBeVisible()
      expect(existsSync(join(extra, 'Projects', 'Beta'))).toBe(true)
      await page.screenshot({ path: screenshotPath('home-folders-extra-root') })

      // remove from the desktop: the icon goes, the setting empties, the disk is untouched
      await page.locator('.dock-item[aria-label="Desktop"]').click()
      await extraIcon.click({ button: 'right' })
      await page.locator('.folder-menu button', { hasText: 'Remove folder from desktop' }).click()
      await expect(page.locator(`.desktop-icon-item[title="${extra}"]`)).toHaveCount(0)
      await expect(rootIcons).toHaveCount(1)
      await expect
        .poll(() => {
          const settings = JSON.parse(readFileSync(join(userDataDir, 'app-settings.json'), 'utf8'))
          return settings.folderRoots
        })
        .toEqual([])
      expect(existsSync(join(extra, 'Projects', 'plan.md'))).toBe(true)
      expect(existsSync(join(extra, 'Projects', 'Beta'))).toBe(true)
    } finally {
      await closeAndSaveVideo(launched, 'home-folders-roots')
      rmSync(extra, { recursive: true, force: true })
    }
  })

  test('a file created from a folder view lands in that folder', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { defaultSaveDir: root },
      videoDir: 'home-folders-new-file',
    })
    const { page, app } = launched
    try {
      await page.locator(`.desktop-icon-item[title="${root}"]`).dblclick()
      await page
        .locator('.recent-list .folder-item', { hasText: 'Personal' })
        .locator('.recent-name')
        .click()
      await expect(page.locator('.recent-list .recent-name', { hasText: 'notes.md' })).toBeVisible()
      // the blank PDF is written synchronously by the shell, so it exercises the pending-folder path
      await page.locator('.quick-card', { hasText: 'AI PDF' }).click()
      const hasPdf = (dir: string) =>
        existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.pdf'))
      await expect.poll(() => hasPdf(join(root, 'Personal')), { timeout: 15_000 }).toBe(true)
      expect(hasPdf(root)).toBe(false)
      // and the tab opened on the moved path, not the vanished root one
      await expect(page.locator('.tab-bar .tab-item', { hasText: '.pdf' })).toBeVisible()
      // a second New from the same folder view: with genoffice#1036 nothing lands on
      // disk until the user saves — the folder only pre-selects the Save As
      // location, so the view must stay clean
      await page.locator('.tab-bar .tab-item.tab-home').click()
      await page.locator('.quick-card', { hasText: 'AI Sheets' }).click()
      await expect(page.locator('.tab-bar .tab-item', { hasText: '.xlsx' })).toBeVisible()
      const hasXlsx = (dir: string) =>
        existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.xlsx'))
      expect(hasXlsx(join(root, 'Personal'))).toBe(false)
      expect(hasXlsx(root)).toBe(false)
      // back home: the new tab must not block shutdown
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus())
    } finally {
      await closeAndSaveVideo(launched, 'home-folders-new-file')
    }
  })
})
