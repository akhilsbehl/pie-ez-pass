import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent'
import { Input, SelectList, fuzzyFilter, truncateToWidth } from '@earendil-works/pi-tui'
import type { Component, Focusable, KeybindingsManager, TUI } from '@earendil-works/pi-tui'
import type { ReviewPath } from './config.js'
import type { ModelIdentity, ReviewModel, ReviewModelRegistry } from './model.js'
import { availableReviewModels, modelSearchText, sameModel } from './model.js'
import { createReviewDeadline, raceWithSignal } from './review-deadline.js'

export type ModelPickerResult = { kind: 'inherit' } | { kind: 'model'; model: ModelIdentity } | undefined
const INHERIT = 'inherit'
const REFRESH_TIMEOUT_MS = 15_000

export function searchReviewModels(models: readonly ReviewModel[], query: string, current: ModelIdentity): ReviewModel[] {
  const sorted = [...models].sort((left, right) =>
    Number(sameModel(right, current)) - Number(sameModel(left, current)) ||
    left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id))
  return query.trim() ? fuzzyFilter(sorted, query, modelSearchText) : sorted
}

/** Public TUI-only picker. No conversation settings, private runtime, or inference. */
export class ReviewModelPicker implements Component, Focusable {
  readonly input = new Input()
  private list: SelectList
  private models: ReviewModel[] = []
  private filtered: ReviewModel[] = []
  private selectedIndex = 0
  private controller = new AbortController()
  private closed = false
  private checking = false
  private status = 'Refreshing catalog and authenticated models…'
  private loaded = false
  private _focused = false

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value; this.input.focused = value }

  constructor(
    private tui: Pick<TUI, 'requestRender'>,
    private theme: Theme,
    private keys: KeybindingsManager,
    private registry: ReviewModelRegistry,
    private path: ReviewPath,
    private current: ModelIdentity,
    private inherited: ModelIdentity,
    private done: (result: ModelPickerResult) => void,
  ) {
    this.list = this.buildList()
    void this.refresh()
  }

  private buildList(): SelectList {
    const items = this.filtered.map((model, index) => ({
      value: String(index), label: `${model.id} [${model.provider}]${sameModel(model, this.current) ? ' (current)' : ''}`,
      description: model.name,
    }))
    // A config action, always reachable even with no search matches.
    items.push({ value: INHERIT, label: 'Use inherited model pair', description: `${this.inherited.provider}/${this.inherited.id}` })
    return new SelectList(items, 10, {
      selectedPrefix: text => this.theme.fg('accent', text), selectedText: text => this.theme.fg('accent', text),
      description: text => this.theme.fg('muted', text), scrollInfo: text => this.theme.fg('dim', text), noMatch: text => this.theme.fg('warning', text),
    }, { minPrimaryColumnWidth: 1, maxPrimaryColumnWidth: Number.MAX_SAFE_INTEGER })
  }

  private filter(): void {
    this.filtered = searchReviewModels(this.models, this.input.getValue(), this.current)
    this.selectedIndex = Math.min(this.selectedIndex, this.filtered.length)
    this.list = this.buildList()
    this.list.setSelectedIndex(this.selectedIndex)
  }

  private async refresh(): Promise<void> {
    const deadline = createReviewDeadline(REFRESH_TIMEOUT_MS, this.controller.signal)
    try {
      let warning = ''
      try {
        const result = await raceWithSignal(this.registry.refresh({ signal: deadline.signal }), deadline.signal)
        warning = result.aborted ? 'Catalog refresh aborted. ' : result.errors.size ? 'Catalog refresh failed; using cached catalog. ' : ''
      } catch (error) {
        if (deadline.signal.aborted) throw error
        warning = 'Catalog refresh failed; using cached catalog. '
      }
      this.models = await raceWithSignal(availableReviewModels(this.registry, this.path, deadline.signal), deadline.signal)
      if (this.closed) return
      this.loaded = true
      this.status = `${warning}Authentication checked; availability does not prove quota or reachability.`
      this.filter()
    } catch {
      if (this.closed) return
      this.status = deadline.timedOut() ? 'Model discovery timed out. Cancel and try again.' : 'Model discovery failed. Check /login and try again.'
    } finally {
      deadline.dispose()
      if (!this.closed) this.tui.requestRender()
    }
  }

  private finish(result: ModelPickerResult): void { this.dispose(); this.done(result) }

  private async select(): Promise<void> {
    if (this.checking || this.closed) return
    if (this.selectedIndex === this.filtered.length) { this.finish({ kind: 'inherit' }); return }
    const model = this.filtered[this.selectedIndex]
    if (model === undefined) return
    this.checking = true
    this.status = 'Rechecking selected model authentication…'
    this.tui.requestRender()
    const deadline = createReviewDeadline(REFRESH_TIMEOUT_MS, this.controller.signal)
    try {
      const available = await raceWithSignal(availableReviewModels(this.registry, this.path, deadline.signal, model.provider), deadline.signal)
      if (this.closed) return
      if (available.some(entry => sameModel(entry, model))) { this.finish({ kind: 'model', model: { provider: model.provider, id: model.id } }); return }
      this.models = this.models.filter(entry => !sameModel(entry, model))
      this.filter()
      this.status = 'Selected model is no longer available. Check /login; no config was changed.'
    } catch {
      if (!this.closed) this.status = 'Could not recheck authentication; no config was changed.'
    } finally {
      deadline.dispose()
      this.checking = false
      if (!this.closed) this.tui.requestRender()
    }
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, 'tui.select.cancel')) { this.finish(undefined); return }
    if (this.checking) return
    if (this.keys.matches(data, 'tui.input.tab')) this.selectedIndex = this.filtered.length
    else if (this.keys.matches(data, 'tui.select.up')) this.selectedIndex = (this.selectedIndex + this.filtered.length) % (this.filtered.length + 1)
    else if (this.keys.matches(data, 'tui.select.down')) this.selectedIndex = (this.selectedIndex + 1) % (this.filtered.length + 1)
    else if (this.keys.matches(data, 'tui.select.confirm')) { void this.select(); return }
    else {
      const previous = this.input.getValue()
      this.input.handleInput(data)
      if (this.input.getValue() !== previous) { this.selectedIndex = 0; this.filter() }
      this.tui.requestRender()
      return
    }
    this.list.setSelectedIndex(this.selectedIndex)
    this.tui.requestRender()
  }

  render(width: number): string[] {
    const currentAvailable = this.models.some(model => sameModel(model, this.current))
    const selected = this.filtered[this.selectedIndex]
    const lines = [
      this.theme.fg('accent', `Configure ${this.path} model (${this.path === 'sys1' ? 'classifier' : 'chat'})`),
      this.theme.fg('muted', this.status),
      `Configured: ${this.current.provider}/${this.current.id} (${currentAvailable ? 'available' : this.loaded ? 'unavailable; not selectable' : 'checking'})`,
      ...this.input.render(Math.max(1, width)),
      ...(this.loaded && this.models.length === 0 ? ['No authenticated models of this type. Use /login, or cancel.'] : []),
      ...(this.models.length > 0 && this.filtered.length === 0 ? ['No search matches. Clear search, inherit, or cancel.'] : []),
      ...this.list.render(Math.max(1, width)),
      selected ? `${selected.name} — ${selected.provider}/${selected.id}` : `Inherit: ${this.inherited.provider}/${this.inherited.id}`,
      `${this.keys.getKeys('tui.select.up').join('/')} / ${this.keys.getKeys('tui.select.down').join('/')} navigate · ${this.keys.getKeys('tui.select.confirm').join('/')} select · ${this.keys.getKeys('tui.input.tab').join('/')} inherit · ${this.keys.getKeys('tui.select.cancel').join('/')} cancel`,
    ]
    return lines.map(line => truncateToWidth(line, Math.max(0, width)))
  }

  invalidate(): void { this.input.invalidate(); this.list.invalidate() }
  dispose(): void { if (!this.closed) { this.closed = true; this.controller.abort() } }
}

export function pickReviewModel(
  ctx: ExtensionCommandContext, path: ReviewPath, current: ModelIdentity, inherited: ModelIdentity,
): Promise<ModelPickerResult> {
  return ctx.ui.custom<ModelPickerResult>((tui, theme, keys, done) =>
    new ReviewModelPicker(tui, theme, keys, ctx.modelRegistry, path, current, inherited, done))
}
