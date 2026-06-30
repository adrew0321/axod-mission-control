import { chromium, type BrowserContext, type Page, type ElementHandle } from 'playwright';
import type { Command, Result, RawEl } from './protocol';
import { buildSnapshot } from './page-snapshot';
import { classifyClick } from './guard';
import type { CompanionConfig } from './config';

const SELECTOR = 'a, button, input, textarea, select, [role=button], [role=link], [role=textbox]';

export function createBrowser(cfg: CompanionConfig) {
  let ctx: BrowserContext | null = null;
  let page: Page | null = null;
  const refMap = new Map<string, ElementHandle>();
  const refMeta = new Map<string, RawEl>();

  async function ensure(): Promise<Page> {
    if (ctx && page && !page.isClosed()) return page;
    ctx = await chromium.launchPersistentContext(cfg.profileDir, { headless: false, viewport: null });
    page = ctx.pages()[0] ?? (await ctx.newPage());
    return page;
  }

  async function snapshot(p: Page): Promise<Result['snapshot']> {
    refMap.clear();
    refMeta.clear();
    const handles = await p.$$(SELECTOR);
    const raw: Omit<RawEl, 'ref'>[] = [];
    for (const h of handles) {
      const visible = await h.isVisible().catch(() => false);
      if (!visible) continue;
      const info = await h.evaluate((el: Element) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? undefined,
        name: (el.getAttribute('aria-label') || (el as HTMLElement).innerText || (el as HTMLInputElement).placeholder || el.getAttribute('value') || '').trim().slice(0, 80) || undefined,
        type: el.getAttribute('type') ?? undefined,
        href: el.getAttribute('href') ?? undefined,
      }));
      raw.push(info);
      // map the next ref (eN) to this handle, matching buildSnapshot's filter
      if (info.name || info.href || info.tag === 'input') {
        const ref = `e${refMap.size + 1}`;
        refMap.set(ref, h);
        refMeta.set(ref, { ref, ...info });
      }
    }
    const pageText = (await p.evaluate(() => document.body?.innerText ?? '')).slice(0, 8000);
    return buildSnapshot({ url: p.url(), title: await p.title(), pageText, raw });
  }

  async function execute(cmd: Command): Promise<Result> {
    try {
      const p = await ensure();
      switch (cmd.action) {
        case 'navigate':
          await p.goto(cmd.url!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          return { id: cmd.id, status: 'ok', snapshot: await snapshot(p) };
        case 'read':
          return { id: cmd.id, status: 'ok', snapshot: await snapshot(p) };
        case 'wait':
          await p.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
          return { id: cmd.id, status: 'ok', snapshot: await snapshot(p) };
        case 'type': {
          const h = refMap.get(cmd.ref!);
          if (!h) return { id: cmd.id, status: 'error', reason: 'stale ref — re-read the page' };
          await h.fill(cmd.text ?? '');
          return { id: cmd.id, status: 'ok', text: 'typed' };
        }
        case 'click': {
          const meta = refMeta.get(cmd.ref!);
          const h = refMap.get(cmd.ref!);
          if (!h || !meta) return { id: cmd.id, status: 'error', reason: 'stale ref — re-read the page' };
          // HARD GATE: refuse unless explicitly approved.
          const gate = classifyClick(meta, p.url(), cfg.sensitiveDomains);
          if (gate.gated && !cmd.approved) {
            return { id: cmd.id, status: 'blocked', reason: gate.reason };
          }
          await h.click({ timeout: 15_000 });
          await p.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
          return { id: cmd.id, status: 'ok', snapshot: await snapshot(p) };
        }
        default:
          return { id: cmd.id, status: 'error', reason: `unknown action ${cmd.action}` };
      }
    } catch (e) {
      return { id: cmd.id, status: 'error', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async function close() {
    await ctx?.close().catch(() => {});
    ctx = null;
    page = null;
  }

  return { execute, close };
}
